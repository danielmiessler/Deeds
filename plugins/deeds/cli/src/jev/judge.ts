/**
 * Clef as the judge: each commit becomes a raw record (files and diff, never the message), code computes its
 * facts and state, and the question system's stages run in declared order, the way the workshop runner runs
 * them: a stage whose gate holds on the facts and the answers earlier stages returned sends all its questions in
 * one request. Later stages (cap_branch, fix_check, confirm) read earlier answers, so a commit makes one request
 * per stage that runs. The policy turns facts plus answers into cap, fix and tend outcomes, which become deeds.
 *
 * Each request carries only the state fields its stage reads, each cut to its declared cap, after redaction.
 * A state that still holds a secret shape is never sent: every stage gate reads secret_shape_remaining, and every
 * transport refuses a request carrying a secret-shaped string before any byte leaves (refuseSecrets).
 *
 * The question system is pluggable: commitJudge and judgeRepo take a `system` (default: the shipped system.json),
 * and the cache key carries its hash, the engine and the model, so no judgment is served across any of the three.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CACHE_ROOT, cacheKey, readCached, redactSecrets, weekOf, writeCached, type CommitResult, type Report } from "../analyze.ts";
import { DeedsError, EXIT } from "../contract.ts";
import { createModelClient, type FetchLike } from "../egress.ts";
import { cutDiff, listCommits } from "../git.ts";
import type { CapChange, Deed } from "../schema.ts";
import { tallyDeeds } from "../totals.ts";
import { CLEF_MODEL_ID, CLEF_MODEL_NAME, clefEndpoint } from "./client.ts";
import { computeFacts, hasSecretShape, resolveRepoKind, type FactsOptions, type RawFile, type RawRecord, type StateFields } from "./facts.ts";
import { evaluate, stageRuns, truncateText, type Answer, type Answers, type PolicyQuestion, type PolicySystem } from "./policy.ts";
import { nameCap, type NameInput } from "./names.ts";
import { loadSystem, systemHash, type QuestionSystem } from "./system.ts";

/** Commits judged at once. Git reads and judge calls overlap; a 429 from Workers AI is retried with backoff. */
const DEFAULT_CONCURRENCY = 32;
/** A judgment request carries a diff of up to ~100 KB; Clef answers in about a second, so this bounds a stall. */
const TIMEOUT_MS = 60_000;
const CAP_CHANGES: readonly string[] = ["new", "deepened", "regressed", "removed"];

class InvariantViolation extends Error {}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

type WireQuestion =
  | { type: "noul"; instructions: unknown; criteria?: unknown }
  | { type: "choice"; instructions: unknown; criteria: unknown }
  | { type: "score"; instructions: unknown; criteria: unknown };

/** One judgment request, exactly the body that goes over the wire to Workers AI: the model selector, the state and the questions. */
export interface JudgeRequest {
  model: string;
  state: Record<string, string>;
  questions: Record<string, WireQuestion>;
}

export interface JudgeReply {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

/** Sends one request; the live one posts to Clef on Workers AI through the egress client. */
export type JudgeTransport = (req: JudgeRequest) => Promise<JudgeReply>;

/** The two Cloudflare credentials a live run needs. Never logged, never in a request body. */
export interface ClefCredentials {
  accountId: string;
  apiToken: string;
}

/** A failure worth another attempt: a timeout, a network error, HTTP 429 or 5xx. `retryAfterMs` is the server's Retry-After. */
export class RetryableError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
    this.name = "RetryableError";
  }
}

/** A request refused before it left because a string in it still has a credential shape. Never retried. */
export class SecretRefusedError extends Error {
  readonly code = "secret_refused";
  constructor() {
    super("refused: a judgment request still carries a secret-shaped string, so it was not sent");
    this.name = "SecretRefusedError";
  }
}

/** Every string in a request: object keys and values, the state and the question text alike. */
function stringsOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      stringsOf(x, out);
    }
  }
  return out;
}

/** True when any string the request carries still has a credential shape the redaction knows. */
export function carriesSecret(req: JudgeRequest): boolean {
  return stringsOf(req).some(hasSecretShape);
}

/** Throw SecretRefusedError when the request carries a secret shape; every transport calls it before any byte leaves. */
export function refuseSecrets(req: JudgeRequest): void {
  if (carriesSecret(req)) throw new SecretRefusedError();
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const isProb = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** Why an answer does not fit its question, or null when it does. A choice must name one of the question's options. */
export function answerProblem(q: WireQuestion, a: unknown): string | null {
  if (!isObj(a)) return "no answer";
  if (a.type !== q.type) return `answer type ${String(a.type)} for a ${q.type} question`;
  if (a.confidence !== undefined && !isProb(a.confidence)) return "confidence is not a probability";
  if (a.probabilities !== undefined && !(isObj(a.probabilities) && Object.values(a.probabilities).every(isProb))) return "probabilities is not a map of probabilities";
  if (a.type === "noul") return isProb(a.noul) ? null : "noul is not a probability";
  if (a.type === "choice") {
    if (typeof a.choice !== "string") return "choice is not a string";
    return isObj(q.criteria) && !Object.hasOwn(q.criteria, a.choice) ? `choice "${a.choice}" is not an option` : null;
  }
  return typeof a.score === "number" && Number.isFinite(a.score) ? null : "score is not a number";
}

/**
 * The reply from a Workers AI body: the REST envelope `{ success, errors, result: { model, answers, usage } }`, or a
 * bare `{ model, answers, usage }`. Every question asked must carry an answer of its type; otherwise it throws.
 */
export function checkReply(body: unknown, req: JudgeRequest): JudgeReply {
  if (!isObj(body)) throw new Error("Clef reply is not a JSON object");
  if (body.success === false) throw new Error(`Clef reported failure: ${JSON.stringify(body.errors ?? null).slice(0, 200)}`);
  const result = isObj(body.result) ? body.result : body;
  if (!isObj(result.answers)) throw new Error("Clef reply missing answers");
  const answers = result.answers;
  for (const [id, q] of Object.entries(req.questions)) {
    const problem = answerProblem(q, answers[id]);
    if (problem) throw new Error(`Clef reply for "${id}": ${problem}`);
  }
  const model = typeof result.model === "string" && result.model !== "" ? result.model : req.model;
  const reply: JudgeReply = { model, answers: answers as Record<string, Answer> };
  if (isObj(result.usage)) reply.usage = result.usage as NonNullable<JudgeReply["usage"]>;
  return reply;
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | undefined {
  if (header === null || header.trim() === "") return undefined;
  const secs = Number(header.trim());
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/** The live transport: POST to Clef in the user's Workers AI account with their token, bounded by a timeout. */
export function liveTransport(creds: ClefCredentials, fetchImpl?: FetchLike, opts: { timeoutMs?: number } = {}): JudgeTransport {
  const client = createModelClient(fetchImpl ? { fetchImpl } : {});
  const url = clefEndpoint(creds.accountId);
  const scrub = (s: string) => s.split(creds.apiToken).join("***").split(creds.accountId).join("<account>");
  return async (req) => {
    refuseSecrets(req);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await client.request(url, {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.apiToken}`, "Content-Type": "application/json" },
          body: JSON.stringify(req),
          signal: ctl.signal,
        });
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === "EgressError") throw err;
        throw new RetryableError(`Clef ${name === "AbortError" ? "timeout" : "network error"}: ${scrub((err as Error)?.message ?? String(err))}`);
      }
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => undefined);
        throw new RetryableError(`Clef HTTP ${res.status}`, parseRetryAfter(res.headers.get("retry-after")));
      }
      if (res.status !== 200) {
        const detail = scrub((await res.text().catch(() => "")).slice(0, 200));
        throw new Error(`Clef HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch (err) {
        if ((err as Error)?.name === "AbortError") throw new RetryableError("Clef timeout while reading the reply");
        throw new Error("Clef reply was not JSON");
      }
      return checkReply(body, req);
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Canonical JSON: object keys sorted at every depth, so equal requests always serialize alike. */
function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(",")}}`;
  return JSON.stringify(v) ?? "null";
}

/** The key a recorded reply is filed under: sha256 of the request's canonical JSON. */
export function requestKey(req: JudgeRequest): string {
  return createHash("sha256").update(canonicalJson(req)).digest("hex");
}

/**
 * A recording file. Recorded from real Clef replies (scripts/record-clef.ts): `replies` maps each request's
 * requestKey to the reply it got, and a request with no entry fails. A synthetic file instead holds one `answers`
 * map by question id, and each request gets the answers for the questions it asked.
 */
export interface Recording {
  engine?: string;
  model: string;
  replies?: Record<string, { answers: Record<string, Answer>; usage?: JudgeReply["usage"] }>;
  answers?: Record<string, Answer>;
  usage?: JudgeReply["usage"];
}

/**
 * Test seam: `DEEDS_CLEF_RECORDING=<file>` replaces the network with recorded replies (see Recording). When
 * `DEEDS_CLEF_CAPTURE=<file>` is also set, every request body is appended to it as one JSON line, so a test can read
 * exactly what would have left the machine. The secret refusal runs first, as it does on the live transport.
 */
export function recordedTransport(recordingPath: string, capturePath?: string): JudgeTransport {
  if (!existsSync(recordingPath)) throw new DeedsError("not_found", `DEEDS_CLEF_RECORDING: no such file ${recordingPath}`, EXIT.usage);
  const rec = JSON.parse(readFileSync(recordingPath, "utf8")) as Recording;
  return async (req) => {
    refuseSecrets(req);
    if (capturePath) {
      const line = JSON.stringify(req);
      invariant(!line.includes("\n"), "recordedTransport: a captured request is one line");
      appendFileSync(capturePath, `${line}\n`);
    }
    if (rec.replies) {
      const hit = rec.replies[requestKey(req)];
      if (!hit) throw new Error(`no recorded Clef reply for request ${requestKey(req).slice(0, 12)}; re-record with: bun run scripts/record-clef.ts`);
      return checkReply({ model: rec.model, answers: hit.answers, ...(hit.usage ? { usage: hit.usage } : {}) }, req);
    }
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(req.questions)) {
      const a = rec.answers?.[id];
      if (a) answers[id] = a;
    }
    return checkReply({ model: rec.model, answers, ...(rec.usage ? { usage: rec.usage } : {}) }, req);
  };
}

/** How a failed request is retried: bounded attempts, exponential backoff with jitter, Retry-After honoured up to the cap. */
export interface RetryPolicy {
  maxAttempts: number;
  baseMs: number;
  capMs: number;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  maxAttempts: 5,
  baseMs: 1000,
  capMs: 30_000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: Math.random,
};

/** The wait before attempt `attempt + 1`: at least the server's Retry-After, never more than the cap. */
export function retryDelay(attempt: number, retryAfterMs: number | undefined, p: RetryPolicy): number {
  const backoff = p.baseMs * 2 ** (attempt - 1) * (0.5 + 0.5 * p.random());
  return Math.min(p.capMs, Math.max(retryAfterMs ?? 0, backoff));
}

/** Run `fn`, retrying a RetryableError until it succeeds or `maxAttempts` attempts have failed; any other error fails at once. */
export async function withRetry<T>(fn: () => Promise<T>, p: RetryPolicy = DEFAULT_RETRY): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= p.maxAttempts) throw err;
      await p.sleep(retryDelay(attempt, err.retryAfterMs, p));
    }
  }
}

function git(repo: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new DeedsError("git_failed", `git ${args[0]} failed: ${r.stderr.toString().trim()}`, EXIT.error);
  return r.stdout.toString();
}

const STATUS_WORD: Record<string, string> = { A: "added", D: "deleted", R: "renamed", C: "copied", M: "modified", T: "modified" };

async function gitAsync(repo: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new DeedsError("git_failed", `git ${args[0]} failed: ${err.trim()}`, EXIT.error);
  return out;
}

// -l raises the rename limit as the system declares (diff.renameLimit=20000), without a leading git option.
const RENAME = ["--find-renames", "--find-copies-harder", "-l20000"];

/** Files, counts and the redacted diff from the five git outputs; shared by the sync and async readers. */
/**
 * The diff the judge sees: cut at whole lines past MAX_DIFF_BYTES, then marked with the line the facts read
 * (`[diff truncated by deeds at K lines; M lines omitted]`), so a cut commit never reads as complete.
 */
export function cutForJudge(diffOut: string): string {
  const kept = cutDiff(diffOut);
  if (kept.length === diffOut.length) return diffOut;
  const keptLines = kept.split("\n").length - 1;
  const totalLines = diffOut.split("\n").length - (diffOut.endsWith("\n") ? 1 : 0);
  return `${kept}[diff truncated by deeds at ${keptLines} lines; ${Math.max(0, totalLines - keptLines)} lines omitted]\n`;
}

function buildRaw(repoName: string, sha: string, parentsOut: string, statusOut: string, numstatOut: string, diffOut: string): { raw: RawRecord; redactions: number } {
  const parents = parentsOut.trim().split(/\s+/).length - 1;
  const status = statusOut.split("\n").filter(Boolean);
  const numstat = numstatOut.split("\n").filter(Boolean);
  const counts = numstat.map((l) => l.split("\t")).map(([a, d]) => ({ added: Number(a) || 0, removed: Number(d) || 0 }));
  const files: RawFile[] = status.map((line, i) => {
    const parts = line.split("\t");
    const letter = parts[0]!.charAt(0);
    return { path: parts.at(-1)!, status: STATUS_WORD[letter] ?? "modified", added: counts[i]?.added ?? 0, removed: counts[i]?.removed ?? 0 };
  });
  const diff = cutForJudge(diffOut);
  const clean = redactSecrets(diff);
  return { raw: { repo: repoName, sha, parents, files, diff: clean.text }, redactions: clean.redactions };
}

/** The raw record of one commit: parents, files with line counts, and the redacted diff. The message is never read. */
export function rawRecord(repo: string, repoName: string, sha: string): { raw: RawRecord; redactions: number } {
  return buildRaw(
    repoName,
    sha,
    git(repo, ["rev-list", "--parents", "-n", "1", sha]),
    git(repo, ["show", "--format=", "--name-status", ...RENAME, sha]),
    git(repo, ["show", "--format=", "--numstat", ...RENAME, sha]),
    git(repo, ["show", "--format=", "--no-color", "--unified=3", ...RENAME, sha]),
  );
}

/** The same record as rawRecord, with the git reads running side by side and off the event loop, so a long history reads in parallel. */
export async function rawRecordAsync(repo: string, repoName: string, sha: string): Promise<{ raw: RawRecord; redactions: number }> {
  const [parents, status, numstat, diff] = await Promise.all([
    gitAsync(repo, ["rev-list", "--parents", "-n", "1", sha]),
    gitAsync(repo, ["show", "--format=", "--name-status", ...RENAME, sha]),
    gitAsync(repo, ["show", "--format=", "--numstat", ...RENAME, sha]),
    gitAsync(repo, ["show", "--format=", "--no-color", "--unified=3", ...RENAME, sha]),
  ]);
  return buildRaw(repoName, sha, parents, status, numstat, diff);
}

/** A stage's questions in the API's wire shape. */
export function wireQuestions(questions: PolicyQuestion[]): Record<string, WireQuestion> {
  const out: Record<string, WireQuestion> = {};
  for (const q of questions) {
    if (q.kind === "noul") out[q.id] = { type: "noul", instructions: q.instructions, ...(q.criteria ? { criteria: q.criteria } : {}) };
    else if (q.kind === "choice") out[q.id] = { type: "choice", instructions: q.instructions, criteria: q.options };
    else out[q.id] = { type: "score", instructions: q.instructions, criteria: q.criteria };
  }
  return out;
}

/**
 * Outcomes to deeds: one cap per credited cap commit, one fix, one tend. A cap's name is made by code from the
 * boundary the commit changed (names.ts), never by a model; `naming` carries the facts' boundary delta and file list.
 */
export function outcomesToDeeds(outcomes: Record<string, string>, raw: RawRecord, naming: Pick<NameInput, "boundaryDelta" | "filesText"> = {}): Deed[] {
  const deeds: Deed[] = [];
  const cap = outcomes.cap ?? "none";
  if (CAP_CHANGES.includes(cap)) {
    const name = nameCap({ change: cap as CapChange, files: raw.files, ...naming });
    deeds.push({ kind: "cap", change: cap as CapChange, name, summary: name });
  }
  if (outcomes.fix === "yes") deeds.push({ kind: "fix", summary: "fixes a defect" });
  if (outcomes.tend === "yes") deeds.push({ kind: "tend", summary: "upkeep" });
  return deeds;
}

/** One stage as the judge sends it: its id, its questions in wire shape, and the state fields they read. */
export interface WireStage {
  id: string;
  questions: Record<string, WireQuestion>;
  reads: string[];
}

/** What judging one commit needs besides the commit: the loaded system, its stages in wire shape and the repo's settings. */
export interface CommitJudge {
  system: PolicySystem & { state: StateFields };
  stages: WireStage[];
  kind: ReturnType<typeof resolveRepoKind>;
  settings: FactsOptions;
  transport: JudgeTransport;
  retry: RetryPolicy;
}

/** Options for commitJudge: another question system than the shipped one, another retry policy (tests). */
export interface CommitJudgeOptions {
  system?: QuestionSystem;
  retry?: RetryPolicy;
}

export function commitJudge(transport: JudgeTransport, kind: CommitJudge["kind"], settings: FactsOptions = {}, opts: CommitJudgeOptions = {}): CommitJudge {
  const system = (opts.system ?? loadSystem()) as unknown as PolicySystem & { state: StateFields };
  if (system.stages.length === 0) throw new Error("the question system has no stages");
  const stages = system.stages.map((s) => {
    if (s.questions.length === 0) throw new Error(`question-system stage "${s.id}" has no questions`);
    return { id: s.id, questions: wireQuestions(s.questions), reads: [...new Set(s.questions.flatMap((q) => q.reads))] };
  });
  return { system, stages, kind, settings, transport, retry: opts.retry ?? DEFAULT_RETRY };
}

export interface JudgedCommit {
  deeds: Deed[];
  outcomes: Record<string, string>;
  facts: Record<string, unknown>;
  /** The stages whose questions were sent, in the order they ran; one request each. */
  stagesRun: string[];
  /** Whether any judgment request was sent for this commit. */
  called: boolean;
  model: string | null;
  usage: { input: number; output: number };
}

/**
 * Judge one raw record: facts and state in code, then each stage in declared order, one request per stage whose
 * gate holds on the facts and the answers so far, then the policy and the names. A failed request fails the
 * commit (the caller records it as unjudged and caches nothing), never a partial answer set.
 */
export async function judgeCommit(raw: RawRecord, j: CommitJudge): Promise<JudgedCommit> {
  const built = await computeFacts(raw, j.kind, j.system.state, j.settings);
  const answers: Answers = {};
  const stagesRun: string[] = [];
  let model: string | null = null;
  const usage = { input: 0, output: 0 };
  for (const stage of j.stages) {
    if (!stageRuns(j.system, stage.id, built.facts, answers)) continue;
    const state: Record<string, string> = {};
    for (const f of stage.reads) {
      const v = built.state[f];
      const field = j.system.state[f];
      if (v === undefined || !field) continue;
      state[f] = truncateText(v, field.max_chars, field.truncate ?? "head");
    }
    const req: JudgeRequest = { model: CLEF_MODEL_NAME, state, questions: stage.questions };
    const reply = await withRetry(() => j.transport(req), j.retry);
    stagesRun.push(stage.id);
    model ??= reply.model;
    usage.input += reply.usage?.input_tokens ?? 0;
    usage.output += reply.usage?.output_tokens ?? 0;
    for (const id of Object.keys(stage.questions)) answers[id] = reply.answers[id];
  }
  const outcomes = Object.fromEntries(evaluate(j.system, built.facts, answers).map((t) => [t.decision, t.outcome]));
  const deeds = outcomesToDeeds(outcomes, raw, { boundaryDelta: built.state.boundary_delta ?? "", filesText: built.state.files ?? "" });
  return { deeds, outcomes, facts: built.facts, stagesRun, called: stagesRun.length > 0, model, usage };
}

export interface JudgeOptions {
  repo: string;
  /** owner/name for a GitHub repo, the folder name for a local one; what the repo settings match on. */
  repoName: string;
  label: string;
  since: string;
  until?: string;
  canon: string;
  transport: JudgeTransport;
  settings?: FactsOptions;
  /** The question system to judge with; defaults to the shipped system.json. */
  system?: QuestionSystem;
  retry?: RetryPolicy;
  concurrency?: number;
  /** Where judged commits are cached; defaults to the user cache. A run given a fresh folder is an uncached run. */
  cacheRoot?: string;
  onProgress?: ((done: number, total: number) => void) | undefined;
}

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/** Judge every commit in the window with Clef and report, in the same report shape as every other mode. */
export async function judgeRepo(opts: JudgeOptions): Promise<Report> {
  const system = opts.system ?? loadSystem();
  const hash = systemHash(system);
  const settings = opts.settings ?? {};
  const cacheDir = join(opts.cacheRoot ?? CACHE_ROOT, cacheKey(opts.canon, CLEF_MODEL_ID, "clef", hash));

  const commits = listCommits(opts.repo, opts.since, opts.until);
  const paths = git(opts.repo, ["ls-files"]).split("\n").filter(Boolean);
  const kind = resolveRepoKind(opts.repoName, paths, settings);
  const judge = commitJudge(opts.transport, kind, settings, { system, ...(opts.retry ? { retry: opts.retry } : {}) });
  let redactions = 0;
  let cached = 0;
  let done = 0;
  let calls = 0;
  let answeredBy: string | null = null;
  const tokens = { input: 0, output: 0 };

  const results = await pool(commits, opts.concurrency ?? DEFAULT_CONCURRENCY, async (c): Promise<CommitResult> => {
    const path = join(cacheDir, `${c.sha}.json`);
    try {
      const hit = readCached(path);
      if (hit) {
        cached++;
        return { ...c, deeds: hit };
      }
      const { raw, redactions: n } = await rawRecordAsync(opts.repo, opts.repoName, c.sha);
      redactions += n;
      const judged = await judgeCommit(raw, judge);
      calls += judged.stagesRun.length;
      answeredBy ??= judged.model;
      tokens.input += judged.usage.input;
      tokens.output += judged.usage.output;
      const deeds = judged.deeds;
      writeCached(path, deeds);
      return { ...c, deeds };
    } catch (err) {
      return { ...c, deeds: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      opts.onProgress?.(++done, commits.length);
    }
  });

  const failed = results.filter((r) => r.error !== undefined);
  const weeks = new Map<string, { cap: number; fix: number; tend: number }>();
  const authors = new Map<string, { cap: number; fix: number; tend: number }>();
  for (const r of results) {
    const t = tallyDeeds(r.deeds);
    for (const [map, key] of [[weeks, weekOf(r.date)], [authors, r.author]] as const) {
      const row = map.get(key) ?? { cap: 0, fix: 0, tend: 0 };
      row.cap += t.cap;
      row.fix += t.fix;
      row.tend += t.tend;
      map.set(key, row);
    }
  }
  return {
    repo: opts.label,
    mode: "clef",
    model: answeredBy ? `cloudflare:${answeredBy}` : CLEF_MODEL_ID,
    complete: failed.length === 0,
    tokens,
    calls,
    escalated: 0,
    window: { since: opts.since, until: opts.until ?? null, first: commits[0]?.date ?? null, last: commits.at(-1)?.date ?? null },
    commits: commits.length,
    judged: results.length - failed.length,
    totals: tallyDeeds(results.flatMap((r) => r.deeds)),
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    authors: [...authors].map(([author, v]) => ({ author, ...v })).sort((a, b) => b.cap + b.fix + b.tend - (a.cap + a.fix + a.tend)),
    caps: results.flatMap((r) => r.deeds.flatMap((d) => (d.kind === "cap" ? [{ name: d.name, change: d.change, sha: r.sha.slice(0, 7), author: r.author, date: r.date }] : []))),
    failed: failed.map((r) => ({ sha: r.sha.slice(0, 7), error: r.error! })),
    redactions,
    cached,
  };
}

/** The repo name the settings match on: owner/name for GitHub, the folder name otherwise. */
export function repoNameOf(target: { kind: "github"; owner: string; repo: string } | { kind: "local"; path: string }): string {
  return target.kind === "github" ? `${target.owner}/${target.repo}` : basename(target.path);
}
