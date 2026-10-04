/**
 * Analyze a repository's history over a window: judge every commit's diff into deeds and report the
 * totals, a week-by-week series and a per-author breakdown. Results are cached by commit and canon, so a
 * second run over the same window makes no model calls and returns the same deeds.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCommit, replyUsage, type ModelFn } from "./classify.ts";
import { classifyFast } from "./fast/classify.ts";
import { QUESTION_SET_VERSION } from "./fast/questions.ts";
import { commitDiff, listCommits, type CommitInfo } from "./git.ts";
import type { Deed } from "./schema.ts";
import { tallyDeeds, type Tally } from "./totals.ts";

export type AnalyzeMode = "fast" | "full";

export const CACHE_ROOT = `${process.env.HOME ?? "/tmp"}/.cache/deeds/classified`;

/** Secret-shaped strings recognisable on their own; each whole match is replaced. */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // A key with no END line (the diff was cut, or the hunk stops inside it): everything after BEGIN goes.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant)?[-_]?[A-Za-z0-9_-]{20,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bhooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bya29\.[0-9A-Za-z_-]{20,}/g,
  // JSON Web Tokens: three base64url segments, the first two always starting with an encoded `{"`.
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];
/** Secrets known by their context: group 1 (the name or scheme) is kept, group 2 (the value) is replaced. */
const SECRET_CONTEXTS: RegExp[] = [
  // `Authorization: Bearer <token>`, `Basic <base64>`.
  /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
  // The password inside a URL: scheme://user:<password>@host.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:)([^@\s/'"]{3,})(?=@)/gi,
  // A quoted value under a secret-like name: `api_key = "..."`, `"clientSecret": "..."`.
  /([A-Za-z0-9_.-]*(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["'`])([^"'`\s]{12,})(?=["'`])/gi,
  // An unquoted value under a secret-like name (.env files, shell exports, YAML). It must hold a digit, so
  // ordinary code such as `authHeader = buildHeader(...)` is left intact.
  /([A-Za-z0-9_.-]*(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private)[A-Za-z0-9_.-]*\s*[:=]\s*)(?=[A-Za-z0-9_+/=.-]*\d)([A-Za-z0-9_+/=.-]{12,})/gi,
];

/** Replace every secret-shaped string in `text` before it leaves the machine, and count the replacements. */
export function redactSecrets(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, () => {
      redactions++;
      return "[REDACTED]";
    });
  }
  for (const re of SECRET_CONTEXTS) {
    out = out.replace(re, (_m, head: string) => {
      redactions++;
      return `${head}[REDACTED]`;
    });
  }
  return { text: out, redactions };
}

export interface CommitResult extends CommitInfo {
  deeds: Deed[];
  error?: string;
}

export interface Report {
  repo: string;
  /** fast: typed questions and a fixed policy; full: one full-model read per commit. */
  mode: AnalyzeMode;
  /** The model the run used, `<vendor>:<model>`. */
  model: string;
  /** False when any commit failed: the totals are then a lower bound. */
  complete: boolean;
  /** Tokens the model calls of this run used; cached commits cost none. */
  tokens: { input: number; output: number };
  /** Model calls this run made. */
  calls: number;
  /** Fast-mode commits an `unsure` answer sent to the full-model classifier. */
  escalated: number;
  window: { since: string; until: string | null; first: string | null; last: string | null };
  commits: number;
  /** Commits whose diff was judged (from the model or the cache). `judged + failed.length === commits` always. */
  judged: number;
  totals: Tally;
  weeks: { week: string; cap: number; fix: number; tend: number }[];
  authors: { author: string; cap: number; fix: number; tend: number }[];
  caps: { name: string; change: string; sha: string; author: string; date: string }[];
  failed: { sha: string; error: string }[];
  redactions: number;
  cached: number;
}

/** Monday of the ISO week containing `iso`, as YYYY-MM-DD. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/** The cache key binds the canon, the model, the mode and, in fast mode, the question set. */
export function cacheKey(canon: string, modelId: string, mode: AnalyzeMode): string {
  const scheme = mode === "fast" ? `fast:${QUESTION_SET_VERSION}` : "full";
  return createHash("sha256").update(canon).update("\0").update(modelId).update("\0").update(scheme).digest("hex").slice(0, 16);
}

function cachePath(sha: string, canon: string, modelId: string, mode: AnalyzeMode): string {
  const key = cacheKey(canon, modelId, mode);
  return join(CACHE_ROOT, key, `${sha}.json`);
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

export async function analyzeRepo(opts: {
  repo: string;
  label: string;
  since: string;
  until?: string;
  canon: string;
  model: ModelFn;
  modelId: string;
  /** Defaults to full, the reference classifier; the CLI passes fast by default. */
  mode?: AnalyzeMode;
  concurrency?: number;
  onProgress?: ((done: number, total: number) => void) | undefined;
}): Promise<Report> {
  const commits = listCommits(opts.repo, opts.since, opts.until);
  let redactions = 0;
  let cached = 0;
  let done = 0;
  let escalated = 0;
  let calls = 0;
  const mode: AnalyzeMode = opts.mode ?? "full";
  const tokens = { input: 0, output: 0 };
  const model: ModelFn = async (req) => {
    calls++;
    const reply = await opts.model(req);
    const u = replyUsage(reply);
    tokens.input += u.input;
    tokens.output += u.output;
    return reply;
  };
  const results = await pool(commits, opts.concurrency ?? 6, async (c): Promise<CommitResult> => {
    const path = cachePath(c.sha, opts.canon, opts.modelId, mode);
    try {
      if (existsSync(path)) {
        cached++;
        return { ...c, deeds: JSON.parse(readFileSync(path, "utf8")) as Deed[] };
      }
      const { files, diff } = commitDiff(opts.repo, c.sha);
      // A commit that changes nothing (a clean merge, an empty commit) is judged here: no change, no deeds.
      if (diff.trim() === "") return { ...c, deeds: [] };
      const clean = redactSecrets(diff);
      redactions += clean.redactions;
      let deeds: Deed[];
      if (mode === "fast") {
        const r = await classifyFast({ files, diff: clean.text }, { canon: opts.canon, model });
        if (r.escalated) escalated++;
        deeds = r.deeds;
      } else {
        deeds = await classifyCommit({ files, diff: clean.text }, { canon: opts.canon, model });
      }
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, JSON.stringify(deeds));
      return { ...c, deeds };
    } catch (err) {
      return { ...c, deeds: [], error: err instanceof Error ? err.message : String(err) };
    } finally {
      opts.onProgress?.(++done, commits.length);
    }
  });

  const failed = results.filter((r) => r.error !== undefined);
  const all = results.flatMap((r) => r.deeds);
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
    mode,
    model: opts.modelId,
    complete: failed.length === 0,
    tokens,
    calls,
    escalated,
    window: { since: opts.since, until: opts.until ?? null, first: commits[0]?.date ?? null, last: commits.at(-1)?.date ?? null },
    commits: commits.length,
    judged: results.length - failed.length,
    totals: tallyDeeds(all),
    weeks: [...weeks].sort(([a], [b]) => a.localeCompare(b)).map(([week, v]) => ({ week, ...v })),
    authors: [...authors].map(([author, v]) => ({ author, ...v })).sort((a, b) => b.cap + b.fix + b.tend - (a.cap + a.fix + a.tend)),
    caps: results.flatMap((r) => r.deeds.flatMap((d) => (d.kind === "cap" ? [{ name: d.name, change: d.change, sha: r.sha.slice(0, 7), author: r.author, date: r.date }] : []))),
    failed: failed.map((r) => ({ sha: r.sha.slice(0, 7), error: r.error! })),
    redactions,
    cached,
  };
}

/** The terminal rendering of a report. */
export function renderReport(r: Report): string {
  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const lines = [
    `${r.repo}`,
    `window   ${r.window.first?.slice(0, 10) ?? "-"} to ${r.window.last?.slice(0, 10) ?? "-"}   ${r.commits} commits read${r.cached ? ` (${r.cached} from cache)` : ""}`,
    `mode     ${r.mode} on ${r.model}   ${r.tokens.input} input + ${r.tokens.output} output tokens${r.escalated ? `   ${r.escalated} sent to a full read` : ""}`,
    "",
    `  ${r.totals.cap} caps      ${r.totals.fix} fixes      ${r.totals.tend} tends`,
    "",
  ];
  if (r.weeks.length) {
    lines.push("week         caps fixes tends");
    for (const w of r.weeks) lines.push(`${pad(w.week, 12)} ${pad(w.cap, 4)} ${pad(w.fix, 5)} ${w.tend}`);
    lines.push("");
  }
  if (r.authors.length) {
    lines.push("by author");
    for (const a of r.authors.slice(0, 12)) lines.push(`${pad(a.author, 24)} ${pad(a.cap + " caps", 9)} ${pad(a.fix + " fixes", 10)} ${a.tend} tends`);
    lines.push("");
  }
  if (r.caps.length) {
    lines.push("caps");
    for (const c of r.caps.slice(-15)) lines.push(`  ${c.change === "new" ? "+" : c.change === "deepened" ? "^" : "-"} ${c.name}   ${c.sha} ${c.author}`);
    lines.push("");
  }
  if (r.failed.length) lines.push(`INCOMPLETE: ${r.failed.length} commits could not be judged, so these totals are a lower bound (first: ${r.failed[0]!.sha} ${r.failed[0]!.error})`);
  if (r.redactions) lines.push(`${r.redactions} secret-shaped strings were redacted before leaving this machine`);
  return lines.join("\n").trimEnd();
}
