/**
 * Analyze a repository's history over a window: judge every commit's diff into deeds and report the
 * totals, a week-by-week series and a per-author breakdown. Results are cached by commit and canon, so a
 * second run over the same window makes no model calls and returns the same deeds.
 */
import { reportLines, toText } from "./render.ts";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyCommit, oneDeedPerKind, replyUsage, type ModelFn } from "./classify.ts";
import { commitDiff, listCommits, type CommitInfo } from "./git.ts";
import type { Deed } from "./schema.ts";
import { tallyDeeds, type Tally } from "./totals.ts";

/** full: one full-model read per commit (--mode full); jev: the judgment API, the default (src/jev/judge.ts). */
export type AnalyzeMode = "full" | "jev";
/**
 * Every scheme a cache directory was ever keyed by. `fast` is the retired typed-question mode: its scheme stays
 * so its old entries keep their own directories and are never served to another mode.
 */
export type CacheScheme = AnalyzeMode | "fast";
/** The question-set version the retired fast mode keyed its cache with. */
const RETIRED_FAST_SCHEME = "fast:fast-q1";

export const CACHE_ROOT = `${process.env.HOME ?? "/tmp"}/.cache/deeds/classified`;

/**
 * Private-key armor, each block whole from its header through its END line, or through the end of the text when
 * the END line is missing (the diff was cut, or the hunk stops inside the key). One pattern per format, so a
 * header with no END line takes the rest of the text in one match instead of rescanning it from every header.
 * - PEM and OpenPGP: five dashes, BEGIN, a label ending in PRIVATE KEY (OpenPGP adds BLOCK), five dashes.
 * - SSH2 (RFC 4716 style): the same shape with four dashes and spaces inside them.
 * - PuTTY .ppk: from `PuTTY-User-Key-File-<n>:` through the `Private-MAC:` line.
 */
export const PRIVATE_KEY_BLOCKS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|[\s\S]*$)/g,
  /---- BEGIN [A-Z0-9 ]*PRIVATE KEY ----(?:[\s\S]*?---- END [A-Z0-9 ]*PRIVATE KEY ----|[\s\S]*$)/g,
  /PuTTY-User-Key-File-\d+:(?:[\s\S]*?Private-MAC:[^\n]*|[\s\S]*$)/g,
];

/** Secret-shaped strings recognisable on their own; each whole match is replaced. */
const SECRET_PATTERNS: RegExp[] = [
  ...PRIVATE_KEY_BLOCKS,
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
/**
 * A password under a password-like name, whatever its length or characters: `DB_PASSWORD=hunter2 x!`,
 * `password: "pass phrase"`, `DB_PASS=s3cr3t`. The name is the whole run of name characters and must end in
 * password, passwd, passphrase, or a separate `pass` / `pwd` word (so `bypass`, `compass` and `cwd` do not
 * count), then `=` or `:` (`==`, `===` and `=>` are not assignments), then an optional opening quote, escaped
 * (`\"`) or not, in group 3. The value itself is read by redactPasswords(). Like the name=value patterns below,
 * the name is taken in one step (`(?=(...))\2`), so the scan stays linear.
 */
const PASSWORD_NAME =
  /(?<![A-Za-z0-9_.-])((?=([A-Za-z0-9_.-]+))\2(?<=passw(?:or)?d|passphrase|(?<![A-Za-z0-9])(?:pass|pwd)|[_.-](?:pass|pwd))\\?["']?[ \t]*[:=](?![=>])[ \t]*)(\\?["'`])?/gi;

/** Where an unquoted password ends: a line break, a quote, or a `,`, `;` or space that starts the next `name:` / `name=`. */
const UNQUOTED_PASSWORD_END = /[\r\n"'`]|[,; \t](?=[ \t]*\\?["']?[A-Za-z_][A-Za-z0-9_.-]*\\?["']?[ \t]*[:=])/g;

/**
 * The end of a quoted password that starts at `p`: the matching quote `q` that is not itself escaped, or the end of the
 * line. With `escaped`, the text is one level of string escaping deep (`"{\"password\": \"ab\\\"c\"}"`), so each
 * `\x` pair is read as the character `x` first.
 */
function quotedPasswordEnd(text: string, p: number, q: string, escaped: boolean): number {
  let i = p;
  let innerEscape = false;
  while (i < text.length && text[i] !== "\n" && text[i] !== "\r") {
    const pair = escaped && text[i] === "\\" && i + 1 < text.length;
    const ch = pair ? text[i + 1]! : text[i]!;
    if (!innerEscape && ch === q) return i;
    innerEscape = !innerEscape && ch === "\\";
    i += pair ? 2 : 1;
  }
  return i;
}

/** Replace every password value (see PASSWORD_NAME), keeping its name, separator and quotes. */
function redactPasswords(text: string, onRedact: () => void): string {
  const re = new RegExp(PASSWORD_NAME.source, PASSWORD_NAME.flags);
  let out = "";
  let copied = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const opener = m[3] ?? "";
    const p = m.index + m[1]!.length + opener.length;
    let end: number;
    if (opener) {
      end = quotedPasswordEnd(text, p, opener.at(-1)!, opener.length === 2);
    } else {
      UNQUOTED_PASSWORD_END.lastIndex = p;
      end = UNQUOTED_PASSWORD_END.exec(text)?.index ?? text.length;
    }
    const value = text.slice(p, end);
    if (value && value !== "[REDACTED]") {
      out += text.slice(copied, p) + "[REDACTED]";
      copied = end;
      onRedact();
    }
    re.lastIndex = Math.max(end, m.index + 1);
  }
  return copied === 0 ? text : out + text.slice(copied);
}

/** Secrets known by their context: group 1 (the name or scheme) is kept, the rest of the match (the value) is replaced. */
const SECRET_CONTEXTS: RegExp[] = [
  // `Authorization: Bearer <token>`, `Basic <base64>`.
  /(\b(?:Bearer|Basic|Token)\s+)([A-Za-z0-9._~+/-]{16,}=*)/g,
  // The password inside a URL: scheme://user:<password>@host.
  /(\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:)([^@\s/'"]{3,})(?=@)/gi,
  // A password under a password-like name runs last, in redactPasswords().
  // The two name=value patterns below are written to stay linear on long identifier runs: the name may only
  // start where a run of name characters starts, a lookahead checks that the run holds a secret-like word, and
  // `(?=(...))\2` takes the whole run at once without backtracking into it. They match what
  // `[A-Za-z0-9_.-]*(?:key|...)[A-Za-z0-9_.-]*` would, without its quadratic retries.
  // A quoted value under a secret-like name: `api_key = "..."`, `"clientSecret": "..."`.
  /(?<![A-Za-z0-9_.-])((?=[A-Za-z0-9_.-]*?(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private))(?=([A-Za-z0-9_.-]+))\2["']?\s*[:=]\s*["'`])([^"'`\s]{12,})(?=["'`])/gi,
  // The unquoted name=value case runs last, in redactUnquoted().
];

/**
 * An unquoted value under a secret-like name (.env files, shell exports, YAML): the name and separator, when at
 * least 12 value characters follow. The value is the whole run of `[A-Za-z0-9_+/=.-]` after the separator, and it
 * must hold a digit, so ordinary code such as `authHeader = buildHeader(...)` is left intact. The pattern used to
 * check the digit with a lookahead that rescanned the value from every `name=` in a long run (`key=key=key=...`);
 * redactUnquoted() reads the value's end and the next digit from tables built once per text instead.
 */
const UNQUOTED_NAME = /(?<![A-Za-z0-9_.-])((?=[A-Za-z0-9_.-]*?(?:key|secret|token|passw(?:or)?d|pwd|credential|auth|private))(?=([A-Za-z0-9_.-]+))\2\s*[:=]\s*)(?=[A-Za-z0-9_+/=.-]{12})/gi;
const UNQUOTED_VALUE_CHAR = /[A-Za-z0-9_+/=.-]/;

/**
 * Apply the unquoted name=value rule exactly as the regex
 * `<name>\s*[:=]\s*(?=[A-Za-z0-9_+/=.-]*\d)([A-Za-z0-9_+/=.-]{12,})` (global, case-insensitive) would: a start whose
 * value has no digit is given up and the search goes on from the next character, as the regex engine does.
 */
function redactUnquoted(text: string, onRedact: () => void): string {
  const re = new RegExp(UNQUOTED_NAME.source, UNQUOTED_NAME.flags);
  let m = re.exec(text);
  if (!m) return text;
  const n = text.length;
  // runEnd[i]: end of the value-character run starting at i; nextDigit[i]: first digit at or after i.
  const runEnd = new Int32Array(n + 1);
  const nextDigit = new Int32Array(n + 1);
  runEnd[n] = n;
  nextDigit[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const c = text[i]!;
    runEnd[i] = UNQUOTED_VALUE_CHAR.test(c) ? runEnd[i + 1]! : i;
    nextDigit[i] = c >= "0" && c <= "9" ? i : nextDigit[i + 1]!;
  }
  let out = "";
  let copied = 0;
  for (; m; m = re.exec(text)) {
    const p = m.index + m[1]!.length;
    const end = runEnd[p]!;
    if (nextDigit[p]! < end) {
      out += text.slice(copied, p) + "[REDACTED]";
      copied = end;
      re.lastIndex = end;
      onRedact();
    } else {
      re.lastIndex = m.index + 1;
    }
  }
  return copied === 0 ? text : out + text.slice(copied);
}

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
    out = out.replace(re, (_m: string, head: string) => {
      redactions++;
      return `${head}[REDACTED]`;
    });
  }
  out = redactUnquoted(out, () => redactions++);
  // Passwords go last. Their value runs to the closing quote or the end of the line, so on a line such as
  // `password: null, apiKey: "..."` it takes in the next name; run earlier, that left the key's value with no
  // name in front of it for the rules above to recognise.
  out = redactPasswords(out, () => redactions++);
  return { text: out, redactions };
}

export interface CommitResult extends CommitInfo {
  deeds: Deed[];
  error?: string;
}

export interface Report {
  repo: string;
  /** jev: the judgment API, the default; full: one full-model read per commit. */
  mode: AnalyzeMode;
  /** The model the run used, `<vendor>:<model>`. */
  model: string;
  /** False when any commit failed: the totals are then a lower bound. */
  complete: boolean;
  /** Tokens the model calls of this run used; cached commits cost none. */
  tokens: { input: number; output: number };
  /** Model calls this run made. */
  calls: number;
  /** Kept for the 0.1.0 key set; no current mode escalates, so it is always 0. */
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

/** The week key for a commit whose date cannot be read. */
export const UNDATED_WEEK = "undated";

/** Monday of the ISO week containing `iso`, as YYYY-MM-DD; UNDATED_WEEK when `iso` is not a date, rather than throwing. */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return UNDATED_WEEK;
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

/**
 * The cache key binds the canon, the model (in judgment mode, the judge version), the mode and the question set:
 * the question-system hash in judgment mode, the retired fast set version for fast, so no mode is served another's.
 */
export function cacheKey(canon: string, modelId: string, mode: CacheScheme, systemHash?: string): string {
  if (mode === "jev" && !/^[0-9a-f]{64}$/.test(systemHash ?? "")) {
    throw new Error("cacheKey: judgment mode needs the question-system sha256");
  }
  const scheme = mode === "jev" ? `jev:${systemHash}` : mode === "fast" ? RETIRED_FAST_SCHEME : "full";
  return createHash("sha256").update(canon).update("\0").update(modelId).update("\0").update(scheme).digest("hex").slice(0, 16);
}

function cachePath(sha: string, canon: string, modelId: string): string {
  const key = cacheKey(canon, modelId, "full");
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
  concurrency?: number;
  onProgress?: ((done: number, total: number) => void) | undefined;
}): Promise<Report> {
  const commits = listCommits(opts.repo, opts.since, opts.until);
  let redactions = 0;
  let cached = 0;
  let done = 0;
  let calls = 0;
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
    const path = cachePath(c.sha, opts.canon, opts.modelId);
    try {
      if (existsSync(path)) {
        cached++;
        // A result cached before the one-per-kind limit is held to it as well.
        return { ...c, deeds: oneDeedPerKind(JSON.parse(readFileSync(path, "utf8")) as Deed[]) };
      }
      const { files, diff } = commitDiff(opts.repo, c.sha);
      // A commit that changes nothing (a clean merge, an empty commit) is judged here: no change, no deeds.
      if (diff.trim() === "") return { ...c, deeds: [] };
      const clean = redactSecrets(diff);
      redactions += clean.redactions;
      const deeds = await classifyCommit({ files, diff: clean.text }, { canon: opts.canon, model });
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
    mode: "full",
    model: opts.modelId,
    complete: failed.length === 0,
    tokens,
    calls,
    escalated: 0,
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

/** The terminal rendering of a report: plain, or ANSI colour when `color` is set. */
export function renderReport(r: Report, color = false): string {
  return toText(reportLines(r), color);
}
