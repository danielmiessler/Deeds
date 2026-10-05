/**
 * Jev as the judge: each commit becomes a raw record (files and diff, never the message), code computes its
 * facts and state, the judge stage's questions go to the judgment API in one request per commit, and the
 * policy turns facts plus answers into cap, fix and tend outcomes, which become deeds.
 *
 * The request carries only the state fields the judge stage reads, each cut to its declared cap, after
 * redaction. A state that still holds a secret shape is never sent: the stage gate reads secret_shape_remaining.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CACHE_ROOT, cacheKey, redactSecrets, weekOf, type CommitResult, type Report } from "../analyze.ts";
import { DeedsError, EXIT } from "../contract.ts";
import { createModelClient, type FetchLike } from "../egress.ts";
import { listCommits, MAX_DIFF_BYTES } from "../git.ts";
import type { CapChange, Deed } from "../schema.ts";
import { tallyDeeds } from "../totals.ts";
import { JEV_ENDPOINT } from "./client.ts";
import { computeFacts, resolveRepoKind, type FactsOptions, type RawFile, type RawRecord, type StateFields } from "./facts.ts";
import { evaluate, stageRuns, truncateText, type Answer, type Answers, type PolicyQuestion, type PolicySystem } from "./policy.ts";
import { nameCap, type NameInput } from "./names.ts";
import { loadSystem, systemHash } from "./system.ts";

/** The judge alias; the response names the versioned model that answered. */
export const JEV_MODEL = "jev-latest";
/** What the cache and an unanswered run name. The cache is bound to the system hash as well. */
export const JEV_MODEL_ID = `typesafe:${JEV_MODEL}`;
const JUDGE_STAGE = "judge";
const TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;
/** Commits judged at once. Git reads and Jev calls overlap, so a 700-commit history is judged in well under a minute at this width. */
const DEFAULT_CONCURRENCY = 32;
const CAP_CHANGES: readonly string[] = ["new", "deepened", "regressed", "removed"];

type WireQuestion =
  | { type: "noul"; instructions: unknown; criteria?: unknown }
  | { type: "choice"; instructions: unknown; criteria: unknown }
  | { type: "score"; instructions: unknown; criteria: unknown };

/** One judgment request: what goes over the wire, nothing else. */
export interface JevRequest {
  state: Record<string, string>;
  model: string;
  questions: Record<string, WireQuestion>;
}

export interface JevReply {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

/** Sends one request; the live one posts to the judgment API through the egress client. */
export type JevTransport = (req: JevRequest) => Promise<JevReply>;

class RetryableError extends Error {}

/** Check a reply carries an answer of the right type for every question asked. */
export function checkReply(body: unknown, req: JevRequest): JevReply {
  const b = body as Partial<JevReply> | null;
  if (!b || typeof b.model !== "string" || !b.answers || typeof b.answers !== "object") throw new Error("Jev reply missing model or answers");
  for (const [id, q] of Object.entries(req.questions)) {
    const a = (b.answers as Record<string, Answer | undefined>)[id];
    if (!a || a.type !== q.type) throw new Error(`Jev reply has no ${q.type} answer for "${id}"`);
    if (a.type === "noul" && !(Number.isFinite(a.noul) && a.noul >= 0 && a.noul <= 1)) throw new Error(`Jev reply for "${id}" is not a probability`);
    if (a.type === "choice" && typeof a.choice !== "string") throw new Error(`Jev reply for "${id}" has no choice`);
    if (a.type === "score" && !Number.isFinite(a.score)) throw new Error(`Jev reply for "${id}" has no score`);
  }
  return b as JevReply;
}

/** The live transport: POST to the judgment endpoint with the user's key, bounded by a timeout. */
export function liveTransport(apiKey: string, fetchImpl?: FetchLike): JevTransport {
  const client = createModelClient(fetchImpl ? { fetchImpl } : {});
  return async (req) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await client.request(JEV_ENDPOINT, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(req),
          signal: ctl.signal,
        });
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === "EgressError") throw err;
        throw new RetryableError(`Jev ${name === "AbortError" ? "timeout" : "network error"}: ${(err as Error)?.message ?? String(err)}`);
      }
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`Jev HTTP ${res.status}`);
      if (res.status !== 200) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        throw new Error(`Jev HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
      }
      return checkReply(await res.json(), req);
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Test seam: `DEEDS_JEV_RECORDING=<file>` replaces the network with a recorded reply. The file is one JSON
 * object `{ "model": "...", "answers": { "<question id>": <answer> } }`; each request gets the answers for the
 * questions it asked. When `DEEDS_JEV_CAPTURE=<file>` is also set, every request body is appended to it as one
 * JSON line, so a test can read exactly what would have left the machine.
 */
export function recordedTransport(recordingPath: string, capturePath?: string): JevTransport {
  if (!existsSync(recordingPath)) throw new DeedsError("not_found", `DEEDS_JEV_RECORDING: no such file ${recordingPath}`, EXIT.usage);
  const rec = JSON.parse(readFileSync(recordingPath, "utf8")) as JevReply;
  return async (req) => {
    if (capturePath) writeFileSync(capturePath, `${JSON.stringify(req)}\n`, { flag: "a" });
    const answers: Record<string, Answer> = {};
    for (const id of Object.keys(req.questions)) {
      const a = rec.answers?.[id];
      if (a) answers[id] = a;
    }
    return checkReply({ model: rec.model, answers, usage: rec.usage }, req);
  };
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof RetryableError) || attempt >= MAX_ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
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
  const diff = diffOut.length > MAX_DIFF_BYTES ? diffOut.slice(0, MAX_DIFF_BYTES) : diffOut;
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

/** The judge stage's questions in the API's wire shape. */
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

/** What judging one commit needs besides the commit: the loaded system, the judge stage's wire questions and the repo's settings. */
export interface CommitJudge {
  system: PolicySystem & { state: StateFields };
  questions: Record<string, WireQuestion>;
  reads: string[];
  kind: ReturnType<typeof resolveRepoKind>;
  settings: FactsOptions;
  transport: JevTransport;
}

export function commitJudge(transport: JevTransport, kind: CommitJudge["kind"], settings: FactsOptions = {}): CommitJudge {
  const system = loadSystem() as unknown as PolicySystem & { state: StateFields };
  const stage = system.stages.find((s) => s.id === JUDGE_STAGE);
  if (!stage) throw new Error(`src/jev/system.json has no "${JUDGE_STAGE}" stage`);
  return { system, questions: wireQuestions(stage.questions), reads: [...new Set(stage.questions.flatMap((q) => q.reads))], kind, settings, transport };
}

export interface JudgedCommit {
  deeds: Deed[];
  outcomes: Record<string, string>;
  facts: Record<string, unknown>;
  /** Whether a judgment request was sent for this commit. */
  called: boolean;
  model: string | null;
  usage: { input: number; output: number };
}

/** Judge one raw record: facts and state in code, one request when the stage runs, then the policy and the names. */
export async function judgeCommit(raw: RawRecord, j: CommitJudge): Promise<JudgedCommit> {
  const built = await computeFacts(raw, j.kind, j.system.state, j.settings);
  const answers: Answers = {};
  let called = false;
  let model: string | null = null;
  const usage = { input: 0, output: 0 };
  if (stageRuns(j.system, JUDGE_STAGE, built.facts, answers)) {
    const state: Record<string, string> = {};
    for (const f of j.reads) {
      const v = built.state[f];
      const field = j.system.state[f];
      if (v === undefined || !field) continue;
      state[f] = truncateText(v, field.max_chars, field.truncate ?? "head");
    }
    const req: JevRequest = { state, model: JEV_MODEL, questions: j.questions };
    called = true;
    const reply = await withRetry(() => j.transport(req));
    model = reply.model;
    usage.input = reply.usage?.input_tokens ?? 0;
    usage.output = reply.usage?.output_tokens ?? 0;
    Object.assign(answers, reply.answers);
  }
  const outcomes = Object.fromEntries(evaluate(j.system, built.facts, answers).map((t) => [t.decision, t.outcome]));
  const deeds = outcomesToDeeds(outcomes, raw, { boundaryDelta: built.state.boundary_delta ?? "", filesText: built.state.files ?? "" });
  return { deeds, outcomes, facts: built.facts, called, model, usage };
}

export interface JudgeOptions {
  repo: string;
  /** owner/name for a GitHub repo, the folder name for a local one; what the repo settings match on. */
  repoName: string;
  label: string;
  since: string;
  until?: string;
  canon: string;
  transport: JevTransport;
  settings?: FactsOptions;
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

/** Judge every commit in the window with Jev and report, in the same report shape as every other mode. */
export async function judgeRepo(opts: JudgeOptions): Promise<Report> {
  const hash = systemHash(loadSystem());
  const settings = opts.settings ?? {};
  const cacheDir = join(opts.cacheRoot ?? CACHE_ROOT, cacheKey(opts.canon, JEV_MODEL_ID, "jev", hash));

  const commits = listCommits(opts.repo, opts.since, opts.until);
  const paths = git(opts.repo, ["ls-files"]).split("\n").filter(Boolean);
  const kind = resolveRepoKind(opts.repoName, paths, settings);
  const judge = commitJudge(opts.transport, kind, settings);
  let redactions = 0;
  let cached = 0;
  let done = 0;
  let calls = 0;
  let answeredBy: string | null = null;
  const tokens = { input: 0, output: 0 };

  const results = await pool(commits, opts.concurrency ?? DEFAULT_CONCURRENCY, async (c): Promise<CommitResult> => {
    const path = join(cacheDir, `${c.sha}.json`);
    try {
      if (existsSync(path)) {
        cached++;
        return { ...c, deeds: JSON.parse(readFileSync(path, "utf8")) as Deed[] };
      }
      const { raw, redactions: n } = await rawRecordAsync(opts.repo, opts.repoName, c.sha);
      redactions += n;
      const judged = await judgeCommit(raw, judge);
      if (judged.called) calls++;
      answeredBy ??= judged.model;
      tokens.input += judged.usage.input;
      tokens.output += judged.usage.output;
      const deeds = judged.deeds;
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(path, JSON.stringify(deeds));
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
    mode: "jev",
    model: answeredBy ? `typesafe:${answeredBy}` : JEV_MODEL_ID,
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
