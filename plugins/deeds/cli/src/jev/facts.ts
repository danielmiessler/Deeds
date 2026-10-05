/**
 * facts.ts — one commit's deterministic facts and the state text the judgment engine reads, built from the
 * commit's raw record (repo, sha, parent count, changed files with line counts, and the redacted unified diff).
 *
 * Each fact and state field is computed the way the question system's `source` / `computed_by` says. Pure apart
 * from the boundary extractor: no network, no model call, no clock. The same raw record and options always give
 * the same facts and state.
 *
 * Where computed_by needs data a raw record cannot carry, the heuristic is documented at the function that
 * applies it. The places this builder departs from a fuller `git` read:
 *   1. repo_kind needs the parent commit's tracked tree. resolveRepoKind applies computed_by's thresholds to
 *      whatever path list the caller has (the parent tree, or a sample of touched paths), with repository plumbing
 *      left out of the ratios (see resolveRepoKind). A kind the user's config declares for the repo wins.
 *   2. The boundary extractor (deeds' tree-sitter engine, src/extract) runs on the before and after text. For an
 *      added or deleted file that text is the whole file. For a modified file the raw record holds only the hunks,
 *      so it runs hunk by hunk, each hunk parsed on its own; where a hunk does not parse cleanly on both sides,
 *      only entries anchored on its +/- lines count (see hunkSideEntries). A changed line the line-level patterns
 *      read as an entry point but no extractor window reports makes the file not extracted. A fragment cut
 *      mid-body often parses to no boundary at all, so whether a modified file holds an entry point (fact
 *      user_surface_touched, clause a) also reads a line-level mirror of the extractor's queries over every
 *      visible line of the file (see visibleEntrySignal).
 *   3. revert_of is null for every commit: the raw record carries no patch-id index of earlier commits and no
 *      recorded deeds for them (computed_by allows null, which falls through to judgment).
 *   4. copy_detection_skipped and whitespace_only are read from the diff text, not from git's stderr or a -w rerun.
 *      whitespace_only is also tightened past computed_by's literal wording (see its definition below).
 *   5. user_surface_touched is null, not false, when a parsed product source file is not shown whole by the raw
 *      record (a modified file's hunks leave part of it out, or an identical rename shows none of it) and nothing
 *      visible in it declares an entry point: computed_by's false needs the whole file. The policy reads null
 *      exactly as false (every rule tests eq true).
 *   6. A raw record whose diff deeds cut at its size cap (the truncation marker) lacks the rest of the cut file and
 *      every file after it. Those files are not extracted: boundary_extracted is false and boundary_delta says
 *      "not extracted" for them, product_diff carries a code-written marker where text is missing, and
 *      product_diff_size is never fits.
 *
 * Repository settings never live in this file: which repositories are excluded, which kind a repository is, and
 * what its users do with it come from the caller (the user's deeds config), all empty by default.
 */
import { PRIVATE_KEY_BLOCKS, redactSecrets } from "../analyze.ts";
import { extractFile } from "../extract/engine.ts";
import { languageOf, type Boundary, type LanguageSpec } from "../extract/languages.ts";
import { truncateText, type Scalar } from "./policy.ts";

class InvariantViolation extends Error {}
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantViolation(message);
}

// ── Secret shapes ────────────────────────────────────────────────────────────
//
// The state text is redacted twice: deeds' own redaction (redactSecrets, the same pass every diff gets before it
// leaves the machine), then the value shapes and the name=value assignment rule below, which the question system
// was measured with. The second pass catches what the first leaves (a key read from the environment, a sample
// placeholder token in a config example), so the engine sees exactly the text the question system was tuned on.

/** Credential and token shapes; `secret_shape_remaining` is true when one survives in the built state. */
const SECRET_VALUE_SHAPES: readonly RegExp[] = [
  /sk-or-v1-[A-Za-z0-9]{16,}/,
  /\bcsk-[A-Za-z0-9]{16,}/,
  /\bsk-(?:ant-|proj-|live-)?[A-Za-z0-9_-]{20,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/,
  // Private-key armor headers: PEM and OpenPGP (`... PRIVATE KEY BLOCK-----`), SSH2, PuTTY .ppk.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/,
  /---- BEGIN [A-Z0-9 ]*PRIVATE KEY ----/,
  /PuTTY-User-Key-File-\d+:/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /Bearer\s+[A-Za-z0-9._-]{24,}/,
];
/** Shapes that are redacted but not counted by `secret_shape_remaining`. */
const REDACTION_EXTRA_SHAPES: readonly RegExp[] = [
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?<!\d)\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/,
  /(?<=[A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s:@\/]*:[^\s@\/]+(?=@)/,
  /\bgh[opsu]_[A-Za-z0-9]{36}/,
  /\bnpm_[A-Za-z0-9]{36}/,
  /\b[sr]k_live_[A-Za-z0-9]{24,}/,
  /\bxoxe(?:\.xox[bp])?-[A-Za-z0-9-]{10,}/,
  /(?<=(?:aws[_ -]?secret[_ -]?(?:access[_ -]?)?key|secret[_ -]?access[_ -]?key)["']?\s*[:=]\s*["']?)[A-Za-z0-9\/+=]{40}(?![A-Za-z0-9\/+=])/i,
];
/**
 * A name holding key, token, secret, password or credential, then `=` or `:`, then a value, JSON spellings
 * included; group 1 keeps the name, the value is replaced. The name is the whole word run from a word boundary,
 * taken in one step (`(?=(...))\2`) after a lazy lookahead finds the word in it, so a long run with no `=` is
 * read once instead of retried from every split. It matches what
 * `\b[A-Za-z0-9_]*(?:KEY|...)[A-Za-z0-9_]*` matched there.
 */
export const SECRET_ASSIGNMENT =
  /(\b(?=[A-Za-z0-9_]*?(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL))(?=([A-Za-z0-9_]+))\2(?:\\?["'])?\s*[=:]\s*(?:\\?["'])?)[A-Za-z0-9._/+~-]{12,}/gi;
const REDACTION_MARK = "[REDACTED]";
const ALL_VALUE_SHAPES: readonly RegExp[] = [...SECRET_VALUE_SHAPES, ...REDACTION_EXTRA_SHAPES].map((r) => new RegExp(r.source, r.flags.includes("g") ? r.flags : `${r.flags}g`));

/** `text` with every secret-shaped value replaced: deeds' redaction, then the shapes above. Run it before any cut. */
export function redactSecretValues(text: string): string {
  if (!text) return text;
  let out = redactSecrets(text).text;
  for (const re of PRIVATE_KEY_BLOCKS) out = out.replace(re, REDACTION_MARK);
  for (const re of ALL_VALUE_SHAPES) out = out.replace(re, REDACTION_MARK);
  return out.replace(SECRET_ASSIGNMENT, (_m, name: string) => name + REDACTION_MARK);
}
/**
 * Whether a credential shape is still in `text`: any shape the redaction replaces (both lists above, the
 * private-key headers included), ignoring a match that is or holds the redaction mark itself (the URL-password
 * shape matches `user:[REDACTED]@host`).
 */
export const hasSecretShape = (text: string): boolean =>
  ALL_VALUE_SHAPES.some((r) => {
    r.lastIndex = 0;
    for (const m of text.matchAll(r)) if (!m[0].includes(REDACTION_MARK)) return true;
    return false;
  });

// ── Inputs ───────────────────────────────────────────────────────────────────

export type RawFile = { path: string; status: string; added: number; removed: number };
export type RawRecord = { repo: string; sha: string; parents: number; files: RawFile[]; diff: string };
export type RepoKind = "code" | "prompts" | "content" | "mixed";
export const REPO_KINDS: readonly RepoKind[] = ["code", "prompts", "content", "mixed"];

/**
 * Repository settings from the user's deeds config. Repositories are named case-insensitively as owner/name or
 * bare name.
 *   excludeRepos     repositories whose commits are never judged; a trailing `*` matches a name prefix.
 *   repoKinds        the kind of a repository, overriding the detection from its tree.
 *   repoProducts     what a repository's users do with it, completing the sentence "Its users …".
 */
export interface FactsOptions {
  excludeRepos?: readonly string[];
  repoKinds?: Readonly<Record<string, RepoKind>>;
  repoProducts?: Readonly<Record<string, string>>;
}

/** The state fields the question system declares, with their caps. */
export type StateField = { max_chars: number; truncate?: "head" | "head_tail" };
export type StateFields = Readonly<Record<string, StateField>>;

export interface CommitFacts {
  state: Record<string, string>;
  facts: Record<string, Scalar | null>;
  /** Why a heuristic decided what it did, for a run log; never read by any decision. */
  notes: string[];
}

/** A setting for `repo` from a name-keyed map: owner/name first, then the bare name. */
function settingFor<T>(map: Readonly<Record<string, T>> | undefined, repo: string): T | undefined {
  if (!map) return undefined;
  const full = repo.toLowerCase();
  const name = full.split("/").at(-1)!;
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === full) return v;
  for (const [k, v] of Object.entries(map)) if (k.toLowerCase() === name) return v;
  return undefined;
}

/** Whether the config excludes `repo`, matched on owner/name or bare name, with `*` as a trailing prefix wildcard. */
export function isRepoExcluded(repo: string, opts: FactsOptions): boolean {
  const full = repo.trim().toLowerCase().replace(/\.git$/, "");
  const name = full.split("/").at(-1)!;
  return (opts.excludeRepos ?? []).some((pattern) => {
    const p = pattern.trim().toLowerCase();
    if (p.endsWith("*")) return full.startsWith(p.slice(0, -1)) || name.startsWith(p.slice(0, -1));
    return full === p || name === p;
  });
}

// ── The deeds boundary extractor (the engine behind `deeds extract`) ─────────

type Extractor = {
  extractFile: (spec: LanguageSpec, path: string, text: string) => Promise<{ boundaries: Boundary[]; hasError: boolean }>;
  languageOf: (path: string) => LanguageSpec | undefined;
};
const EXTRACTOR: Extractor = { extractFile, languageOf };

// ── Diff parsing ─────────────────────────────────────────────────────────────

type Hunk = {
  oldStart: number;
  newStart: number;
  /** git's function context after the closing @@: a line of the before-file above the hunk ("" when none). */
  context: string;
  lines: string[] /* each starts with ' ', '+', '-' or '\\' */;
};
type Section = {
  oldPath: string;
  newPath: string;
  text: string; // the raw section text, raw truncation marker removed
  newFile: boolean;
  deletedFile: boolean;
  similarity: number | null;
  renameFrom: string | null;
  copyFrom: string | null;
  binary: boolean;
  hunks: Hunk[];
  truncated: boolean; // the raw diff's truncation marker fell inside this section
};

const TRUNC_MARKER = /^\[diff truncated by deeds at \d+ lines; \d+ lines omitted\]$/m;

function parseDiff(diff: string): { sections: Section[] } {
  const sections: Section[] = [];
  const re = /^diff --(?:git|cc|combined) (.+)$/gm;
  const starts: { index: number; header: string }[] = [];
  for (let m = re.exec(diff); m; m = re.exec(diff)) starts.push({ index: m.index, header: m[1]! });
  starts.forEach((s, i) => {
    let text = diff.slice(s.index, starts[i + 1]?.index ?? diff.length);
    let truncated = false;
    const tm = TRUNC_MARKER.exec(text);
    if (tm) {
      truncated = true;
      text = text.slice(0, tm.index).replace(/\n+$/, "\n");
    }
    const pair = /^a\/(.+?) b\/(.+)$/.exec(s.header);
    const oldP = pair ? pair[1]! : s.header.trim();
    const newP = pair ? pair[2]! : s.header.trim();
    const sec: Section = {
      oldPath: oldP, newPath: newP, text, newFile: false, deletedFile: false, similarity: null,
      renameFrom: null, copyFrom: null, binary: false, hunks: [], truncated,
    };
    let hunk: Hunk | null = null;
    for (const line of text.replace(/\n$/, "").split("\n").slice(1)) {
      const h = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@+ ?(.*)$/.exec(line);
      if (h) { hunk = { oldStart: Number(h[1]), newStart: Number(h[2]), context: h[3] ?? "", lines: [] }; sec.hunks.push(hunk); continue; }
      if (hunk) {
        if (line === "") hunk.lines.push(" "); // a context line whose single space was stripped
        else if (/^[ +\-\\]/.test(line)) hunk.lines.push(line);
        continue;
      }
      if (line.startsWith("new file mode")) sec.newFile = true;
      else if (line.startsWith("deleted file mode")) sec.deletedFile = true;
      else if (line.startsWith("similarity index ")) sec.similarity = Number(line.slice(17).replace("%", ""));
      else if (line.startsWith("rename from ")) sec.renameFrom = line.slice(12);
      else if (line.startsWith("copy from ")) sec.copyFrom = line.slice(10);
      else if (line.startsWith("Binary files ")) sec.binary = true;
    }
    sections.push(sec);
  });
  return { sections };
}

const beforeText = (s: Section): string => s.hunks.map((h) => h.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1)).join("\n")).join("\n");
const afterText = (s: Section): string => s.hunks.map((h) => h.lines.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1)).join("\n")).join("\n");
const addedLines = (s: Section): string[] => s.hunks.flatMap((h) => h.lines.filter((l) => l[0] === "+").map((l) => l.slice(1)));
/** Lines from the top of the after-text, when the first hunk starts at line 1 (else null: the top is not visible). */
const afterHead = (s: Section | undefined): string[] | null => {
  if (!s || !s.hunks.length || s.hunks[0]!.newStart > 1) return null;
  return s.hunks[0]!.lines.filter((l) => l[0] === " " || l[0] === "+").map((l) => l.slice(1));
};
const beforeHead = (s: Section | undefined): string[] | null => {
  if (!s || !s.hunks.length || s.hunks[0]!.oldStart > 1) return null;
  return s.hunks[0]!.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
};

// ── File classification (the classifier in the product_files fact) ──────────

type FileClass =
  | "source" | "app_config" | "content" | "asset" | "test" | "docs" | "draft" | "archived"
  | "dependency_manifest" | "lockfile" | "ci_build" | "generated_vendored";
const PRODUCT_CLASSES: ReadonlySet<FileClass> = new Set(["source", "app_config", "content", "asset"]);

const segs = (p: string): string[] => p.toLowerCase().split("/");
const base = (p: string): string => p.split("/").at(-1)!;
const lbase = (p: string): string => base(p).toLowerCase();
const ext = (p: string): string => { const b = lbase(p); const i = b.lastIndexOf("."); return i <= 0 ? "" : b.slice(i); };
const underDir = (p: string, dirs: readonly string[]): boolean => segs(p).slice(0, -1).some((s) => dirs.includes(s));

const VERSION_SEG = /^v?\d+(\.\d+)*([-.][0-9a-z.]+)?$/i;
/** A path under releases/<version>/: a frozen copy of the product, never live work. */
export function isSnapshotPath(p: string): boolean {
  const s = p.split("/");
  for (let i = 0; i < s.length - 1; i++) if (/^releases$/i.test(s[i]!) && i + 1 < s.length - 1 && VERSION_SEG.test(s[i + 1]!)) return true;
  return false;
}

const GENERATED_DIRS = ["dist", "build", "out", "vendor", "third_party", "node_modules", "__generated__", "generated", "deps", "external", "pods", "bower_components", ".yarn"];
const GENERATED_SUFFIX = [".min.js", ".min.css", ".map", ".snap", ".d.ts", ".bundle.js", ".chunk.js", ".g.dart", ".pb.go", "_pb2.py"];
const GENERATED_MARK = /@generated|DO NOT EDIT|auto-generated|Code generated/;
const LOCKFILES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "cargo.lock", "gemfile.lock", "poetry.lock", "pipfile.lock", "uv.lock", "composer.lock", "go.sum", "mix.lock", "pubspec.lock", "podfile.lock", "packages.lock.json", "flake.lock", "gradle.lockfile"]);
const MANIFESTS = new Set(["package.json", "pyproject.toml", "setup.py", "setup.cfg", "pipfile", "go.mod", "cargo.toml", "gemfile", "composer.json", "pom.xml", "mix.exs", "pubspec.yaml"]);
const CI_DIRS = [".github", ".circleci", ".buildkite", ".vscode", ".idea"];
const CI_EXACT = new Set([".gitlab-ci.yml", "makefile", "justfile", "jsconfig.json", ".pre-commit-config.yaml", "bunfig.toml", "renovate.json", "dependabot.yml", ".gitignore", ".gitattributes", ".nvmrc", ".tool-versions", ".editorconfig", ".flake8", "mypy.ini", ".babelrc"]);
const CI_PREFIX = ["dockerfile", "docker-compose", "tsconfig", ".eslintrc", "eslint.config", ".prettierrc", "prettier.config", "biome.json", ".stylelintrc", "stylelint.config", "ruff.toml", ".ruff.toml", "vite.config", "webpack.config", "rollup.config", "esbuild.config", "babel.config", "jest.config", "vitest.config", "playwright.config"];
const GIT_HOUSEKEEPING = new Set([".gitkeep", ".keep", ".gitmodules", ".mailmap", ".git-blame-ignore-revs"]);
const TOOL_DOTFILE = /^\.[a-z0-9_-]+(rc|ignore)(\.(json|ya?ml|js|cjs|mjs|toml))?$/;
const TEST_DIRS = ["test", "tests", "__tests__", "spec", "specs", "e2e", "cypress", "testdata", "fixtures", "__mocks__", "benchmarks"];
const ARCHIVE_DIRS = ["deprecated", ".deprecated", "archive", "archived", "attic"];
const DOC_STEM = /^(readme|changelog|history|contributing|code_of_conduct|license|notice|authors|notes|plan|todo|roadmap)([._-].*)?$/i;
const DOC_EXACT = new Set(["security.md", "isa.md", "isa.html"]);
const DOC_DIRS = ["adr", "rfcs", "doc", "docs", "documentation"];
const PROSE_EXT = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
/**
 * Rule (8)'s docs-named files: README*, CHANGELOG* and the rest only when the extension is a prose one or there
 * is none, so CHANGELOG.md, LICENSE and LICENSE-MIT are docs while a live page or module that happens to share the
 * name (src/pages/changelog.astro, src/router/history.ts, todo.tsx) keeps its own class. The three names in
 * DOC_EXACT are matched exactly, in any case.
 */
export const isDocNamed = (p: string): boolean => {
  const b = lbase(p);
  if (DOC_EXACT.has(b)) return true;
  const e = ext(p);
  return DOC_STEM.test(b) && (e === "" || PROSE_EXT.has(e));
};
const ASSET_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico", ".bmp", ".tif", ".tiff", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".mp3", ".wav", ".ogg", ".flac", ".m4a", ".aac", ".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".kts", ".swift", ".rb", ".php", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".sh", ".bash", ".zsh", ".fish", ".ps1", ".lua", ".ex", ".exs", ".erl", ".scala", ".clj", ".dart", ".m", ".mm", ".vue", ".svelte", ".astro", ".html", ".htm", ".css", ".scss", ".sass", ".less", ".sql", ".graphql", ".gql", ".proto", ".zig", ".nim", ".hs", ".ml", ".r", ".jl", ".pl"]);
const CONFIG_EXT = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".conf", ".xml", ".csv", ".tsv"]);
const DATA_EXT = new Set([".csv", ".tsv", ".json", ".jsonl", ".ndjson", ".parquet", ".xml", ".yaml", ".yml"]);
const DEPLOY_MANIFESTS = new Set(["wrangler.toml", "vercel.json", "netlify.toml", "fly.toml"]);
const CONFIG_DIRS = ["config", "conf", "settings", ".config"];
const CONFIG_NAME = /config|settings|flag|feature|toggle|route|manifest|rewrite|redirect/i;
const MIXED_CONTENT_ROOTS = ["content", "posts", "_posts", "blog", "articles", "wordlists", "lists", "datasets"];
const PRODUCT_MD_DIRS = ["skills", "patterns", "prompts", "commands", "agents", "workflows", "hooks", "packs"];
const PRODUCT_MD_EXT = new Set([".md", ".mdx", ".txt", ".yaml", ".yml", ".hbs", ".template"]);

type ClassifyCtx = { kind: RepoKind | null; skillDirs: ReadonlySet<string> };

const inContentRoot = (p: string): boolean => underDir(p, MIXED_CONTENT_ROOTS);
function inProductMarkdownRoot(p: string, ctx: ClassifyCtx): boolean {
  const dir = p.split("/").slice(0, -1);
  for (let i = dir.length; i > 0; i--) if (ctx.skillDirs.has(dir.slice(0, i).join("/").toLowerCase())) return true;
  return underDir(p, PRODUCT_MD_DIRS);
}

/**
 * Class one live path, first match wins, rules (1)–(13) of the product_files fact in order.
 * `head` is the first lines of the after-text when visible (generated markers, draft front matter); null when not.
 * Paths no rule names, all three this builder's, not computed_by's:
 *   - git's own housekeeping files (.gitkeep, .keep, .gitmodules, .mailmap, .git-blame-ignore-revs) join rule (4)
 *     by name, beside the .gitignore and .gitattributes that rule (4) already lists: rule (4) holds git
 *     housekeeping that is no more CI or build tooling than an empty .gitkeep is.
 *   - a dotfile shaped like a tool's own settings (.<name>rc, .<name>ignore, .<name>rc.json and kin) is ci_build.
 *   - anything else (an unknown extension such as .prisma, or another dotfile such as .htaccess) is app_config, a
 *     structured file the product reads.
 */
function classify(p: string, ctx: ClassifyCtx, head: string[] | null): FileClass {
  const b = lbase(p), e = ext(p), kind: RepoKind = ctx.kind ?? "mixed";
  // (1) generated_vendored
  if (underDir(p, GENERATED_DIRS) || GENERATED_SUFFIX.some((s) => b.endsWith(s)) || /\.generated\.|\.gen\.|_generated\./.test(b)) return "generated_vendored";
  if (head && head.slice(0, 10).some((l) => GENERATED_MARK.test(l))) return "generated_vendored";
  // (2) lockfile, (3) dependency_manifest
  if (LOCKFILES.has(b)) return "lockfile";
  if (MANIFESTS.has(b) || /^requirements.*\.txt$/.test(b) || /^build\.gradle/.test(b) || b.endsWith(".csproj")) return "dependency_manifest";
  // (4) ci_build
  if (underDir(p, CI_DIRS) || CI_EXACT.has(b) || CI_PREFIX.some((x) => b.startsWith(x))) return "ci_build";
  if (GIT_HOUSEKEEPING.has(b)) return "ci_build";
  if (kind !== "prompts" && underDir(p, [".claude", ".cursor"])) return "ci_build";
  // (5) test
  if (underDir(p, TEST_DIRS) || /\.(test|spec)\.[^.]+$/.test(b) || /_test\.go$/.test(b) || /^test_.*\.py$/.test(b) || /_test\.py$/.test(b) || b === "conftest.py") return "test";
  // (6) archived
  if (underDir(p, ARCHIVE_DIRS)) return "archived";
  // (7) draft: drafts directories here; front-matter drafts below, once the path is known to be content
  if (underDir(p, ["drafts", "_drafts"])) return "draft";
  // (8) docs
  const atRoot = !p.includes("/");
  if (isDocNamed(p)) return "docs";
  if (kind !== "content" && (underDir(p, DOC_DIRS) || underDir(p, ["examples", "example"]))) return "docs";
  if (kind !== "content" && atRoot && PROSE_EXT.has(e)) return "docs";
  if (PROSE_EXT.has(e)) {
    if (kind === "code") return "docs";
    if (kind === "mixed" && !inContentRoot(p)) return "docs";
    if (kind === "prompts" && !inProductMarkdownRoot(p, ctx)) return "docs";
  }
  // (9) product markdown
  if (kind === "prompts" && PRODUCT_MD_EXT.has(e) && inProductMarkdownRoot(p, ctx)) return "source";
  // (10) asset, (11) source
  if (ASSET_EXT.has(e)) return "asset";
  if (SOURCE_EXT.has(e)) return "source";
  // (12) app_config, with the content carve-out
  const contentScope = kind === "content" || (kind === "mixed" && inContentRoot(p));
  if (CONFIG_EXT.has(e) || b === ".env.example" || DEPLOY_MANIFESTS.has(b)) {
    if (contentScope && !DEPLOY_MANIFESTS.has(b) && !underDir(p, CONFIG_DIRS) && !CONFIG_NAME.test(b)) return frontMatterDraft(head) ? "draft" : "content";
    return "app_config";
  }
  // (13) content
  if (contentScope && (PROSE_EXT.has(e) || DATA_EXT.has(e))) return frontMatterDraft(head) ? "draft" : "content";
  // Fallbacks (see the doc comment).
  return TOOL_DOTFILE.test(b) ? "ci_build" : "app_config";
}

/** Front matter at the top of `head` sets draft: true or published: false. */
function frontMatterDraft(head: string[] | null): boolean {
  const fm = frontMatter(head);
  return fm !== null && (/^draft:\s*true\s*$/im.test(fm) || /^published:\s*false\s*$/im.test(fm));
}
function frontMatter(head: string[] | null): string | null {
  if (!head || head[0]?.trim() !== "---") return null;
  const end = head.indexOf("---", 1);
  return end < 0 ? null : head.slice(1, end).join("\n");
}

// ── repo_kind ────────────────────────────────────────────────────────────────

/** Repository plumbing: classes every kind of repository carries in a small, size-independent number. */
const PLUMBING_CLASSES: ReadonlySet<FileClass> = new Set(["generated_vendored", "lockfile", "dependency_manifest", "ci_build"]);

/**
 * repo_kind from computed_by's thresholds over a stand-in for the parent's tracked tree: every live path any
 * record of this repo touches in the input (old and new paths of renames included). That sample is far smaller
 * than a real tree, so the prompts thresholds (3 SKILL.md, 10 patterns/<name>/system.md) are hard to reach;
 * they are applied unchanged.
 *
 * Sample-bias correction (this builder's, not computed_by's): the ratios leave out plumbing paths (classes
 * generated_vendored, lockfile, dependency_manifest and ci_build, classified with the kind unknown). A real tree
 * holds a handful of those among hundreds of files, so they barely move its ratios; a sample of three touched
 * paths can be one-third CI config, which would push a plain Worker repo (src/index.ts, wrangler.toml,
 * .github/workflows/ci.yml) below the 40% source line. When the sample holds nothing but plumbing, every path
 * counts. Content-shaped: prose (.md .mdx .rst .adoc .txt) and data (.csv .tsv .jsonl .ndjson .parquet) files
 * outside docs-named files and docs directories. Source: SOURCE_EXT.
 */
export function resolveRepoKind(repo: string, paths: readonly string[], opts: FactsOptions = {}): RepoKind {
  const declared = settingFor(opts.repoKinds, repo);
  if (declared) return declared;
  const all = [...new Set(paths)].filter((p) => !isSnapshotPath(p));
  if (all.filter((p) => lbase(p) === "skill.md").length >= 3) return "prompts";
  if (new Set(all.filter((p) => /(^|\/)patterns\/[^/]+\/system\.md$/i.test(p))).size >= 10) return "prompts";
  const unknownKind: ClassifyCtx = { kind: null, skillDirs: new Set() };
  const nonPlumbing = all.filter((p) => !PLUMBING_CLASSES.has(classify(p, unknownKind, null)));
  const live = nonPlumbing.length ? nonPlumbing : all;
  const n = live.length || 1;
  const contentShaped = live.filter((p) => {
    const e = ext(p);
    if (!(PROSE_EXT.has(e) || [".csv", ".tsv", ".jsonl", ".ndjson", ".parquet"].includes(e))) return false;
    return !isDocNamed(p) && !underDir(p, DOC_DIRS);
  }).length;
  const source = live.filter((p) => SOURCE_EXT.has(ext(p))).length;
  if (contentShaped / n >= 0.6 && source / n < 0.2) return "content";
  if (source / n >= 0.4) return "code";
  return "mixed";
}

const KIND_SENTENCE: Record<RepoKind, string> = {
  code: "A code repository whose product is software.",
  prompts: "A prompts repository whose product is skills, workflows and prompt patterns written in markdown, which are its source code.",
  content: "A content repository whose product is its content (wordlists, posts, datasets).",
  mixed: "A mixed repository whose product is part software and part content.",
};

// ── Per-file view ────────────────────────────────────────────────────────────

type ViewStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "published" | "archived";
type FileView = {
  path: string;
  oldPath: string | null;
  git: "A" | "M" | "D" | "R" | "C";
  similarity: number | null;
  cls: FileClass;
  srcCls: FileClass | null;
  status: ViewStatus;
  section: Section | undefined;
  /** The section's text is complete (not cut by the raw diff's truncation, not missing). */
  visible: boolean;
  isItem: boolean;
  srcIsItem: boolean;
  raw: RawFile;
};

function isItemFile(p: string, cls: FileClass, kind: RepoKind | null): boolean {
  if (cls === "content") return true;
  if (kind === "prompts" && cls === "source" && PROSE_EXT.has(ext(p))) {
    if (lbase(p) === "skill.md") return true;
    if (underDir(p, ["workflows"])) return true;
    if (/(^|\/)patterns\/[^/]+\/system\.md$/i.test(p)) return true;
    const parent = segs(p).at(-2);
    if (parent && ["commands", "agents", "prompts"].includes(parent) && ext(p) === ".md") return true;
  }
  return false;
}

function buildViews(raw: RawRecord, kind: RepoKind | null, sections: Section[], missingAfterTrunc: Set<string>): FileView[] {
  const allPaths = raw.files.map((f) => f.path);
  const skillDirs = new Set(allPaths.filter((p) => lbase(p) === "skill.md").map((p) => p.split("/").slice(0, -1).join("/").toLowerCase()));
  const ctx: ClassifyCtx = { kind, skillDirs };
  const byNew = new Map(sections.map((s) => [s.newPath, s]));
  const views: FileView[] = [];
  for (const f of raw.files) {
    if (isSnapshotPath(f.path)) continue;
    const sec = byNew.get(f.path);
    const st = f.status.toLowerCase();
    const git: FileView["git"] = st.startsWith("add") ? "A" : st.startsWith("del") ? "D" : st.startsWith("ren") ? "R" : st.startsWith("cop") ? "C" : "M";
    const oldPath = git === "R" ? (sec?.renameFrom ?? sec?.oldPath ?? null) : git === "C" ? (sec?.copyFrom ?? sec?.oldPath ?? null) : null;
    const similarity = git === "R" || git === "C" ? (sec?.similarity ?? null) : null;
    const after = git === "D" ? null : afterHead(sec);
    const cls = classify(f.path, ctx, after);
    const srcCls = oldPath ? classify(oldPath, ctx, beforeHead(sec) ?? after) : null;
    let status: ViewStatus = git === "A" ? "added" : git === "D" ? "deleted" : git === "R" ? "renamed" : git === "C" ? "copied" : "modified";
    if ((git === "R" || git === "C") && srcCls) {
      const srcProd = PRODUCT_CLASSES.has(srcCls), dstProd = PRODUCT_CLASSES.has(cls);
      if (!srcProd && dstProd) status = srcCls === "draft" ? "published" : "added";
      else if (srcProd && !dstProd) status = cls === "archived" ? "archived" : "deleted";
    }
    // A modified content file whose front matter goes from draft to live is published, read from the hunk at line 1.
    if (git === "M" && cls === "content") {
      const before = frontMatter(beforeHead(sec)), afterFm = frontMatter(afterHead(sec));
      const wasDraft = before !== null && (/^draft:\s*true\s*$/im.test(before) || /^published:\s*false\s*$/im.test(before));
      const isLive = afterFm !== null && !/^draft:\s*true\s*$/im.test(afterFm) && !/^published:\s*false\s*$/im.test(afterFm);
      if (wasDraft && isLive) status = "published";
    }
    const visible = !!sec && !sec.truncated && !missingAfterTrunc.has(f.path);
    views.push({
      path: f.path, oldPath, git, similarity, cls, srcCls, status, section: sec, visible,
      isItem: isItemFile(f.path, cls, kind), srcIsItem: oldPath && srcCls ? isItemFile(oldPath, srcCls, kind) : false, raw: f,
    });
  }
  return views;
}

const isProduct = (v: FileView): boolean => PRODUCT_CLASSES.has(v.cls);
/** Product-class path, or a path that left the product (renamed into a non-product class): it counts for removals. */
const copiedWithChanges = (v: FileView, views: FileView[]): boolean =>
  v.git === "C" && (v.similarity ?? 0) < 100 && !views.some((o) => o.path === v.oldPath && o.git === "D");

// ── Boundary delta ───────────────────────────────────────────────────────────

type Entry = { kind: "route" | "command" | "ui handler" | "export"; name: string; file: string; detail?: string | undefined; publicEntry?: boolean };
const KIND_NAME: Record<Boundary["kind"], Entry["kind"]> = { route: "route", cli: "command", ui: "ui handler", export: "export" };

/**
 * Public entry point, by file. computed_by reads the package entry from the manifest (package.json main or
 * exports, a top-level __init__.py, lib.rs, a non-internal Go package). The raw record carries a manifest only
 * when the commit changed it, so: a "main"/"module"/"exports" string seen in a changed package.json wins; else the
 * conventional entries index.(ts|js|...) at the root, src/ or lib/; <pkg>/__init__.py or src/<pkg>/__init__.py;
 * src/lib.rs or lib.rs. Go: any package outside an internal/ segment whose package clause is not main (the
 * clause read from the visible text; when it is not visible, a main.go file counts as package main).
 */
function isPublicEntryFile(p: string, language: string, visibleText: string, manifestEntries: Set<string>): boolean {
  const lp = p.toLowerCase();
  if (manifestEntries.size && (language === "typescript" || language === "tsx" || language === "javascript")) {
    const stem = lp.replace(/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, "");
    if ([...manifestEntries].some((m) => m.replace(/^\.\//, "").replace(/\.(d\.ts|ts|js|mjs|cjs)$/, "").replace(/^dist\//, "src/") === stem)) return true;
  }
  switch (language) {
    case "typescript": case "tsx": case "javascript":
      return /^((src|lib)\/)?index\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(lp);
    case "python":
      return /^([^/]+|src\/[^/]+)\/__init__\.py$/.test(lp);
    case "rust":
      return lp === "src/lib.rs" || lp === "lib.rs";
    case "go": {
      if (segs(p).slice(0, -1).includes("internal")) return false;
      const pkg = /^package\s+(\w+)/m.exec(visibleText)?.[1];
      if (pkg) return pkg !== "main";
      return lbase(p) !== "main.go";
    }
    default:
      return false;
  }
}

/** package.json main/module/exports strings visible in a changed package.json (after view). */
function manifestEntryFiles(views: FileView[]): Set<string> {
  const out = new Set<string>();
  for (const v of views) {
    if (lbase(v.path) !== "package.json" || !v.section) continue;
    for (const m of afterText(v.section).matchAll(/"(?:main|module|types|exports|import|require|default)"\s*:\s*"([^"]+)"/g)) out.add(m[1]!.toLowerCase());
  }
  return out;
}

/**
 * Commands declared in manifests, from a fragment: package.json "bin" (string or object), pyproject
 * [project.scripts], Cargo [[bin]] name. Section tracking runs over the visible lines only, so an entry whose
 * section header is outside the hunk is not seen (reported as a limit of the raw record).
 */
function manifestCommands(path: string, text: string): string[] {
  const b = lbase(path), out: string[] = [];
  const lines = text.split("\n");
  if (b === "package.json") {
    const single = /"bin"\s*:\s*"([^"]+)"/.exec(text);
    if (single) out.push(`bin ${single[1]}`);
    let inBin = false;
    for (const l of lines) {
      if (/"bin"\s*:\s*\{/.test(l)) { inBin = true; continue; }
      if (inBin && /^\s*\}/.test(l)) { inBin = false; continue; }
      const kv = inBin ? /^\s*"([^"]+)"\s*:\s*"[^"]+"/.exec(l) : null;
      if (kv) out.push(kv[1]!);
    }
  } else if (b === "pyproject.toml" || b === "cargo.toml") {
    let section = "";
    for (const l of lines) {
      const h = /^\s*\[\[?([^\]]+)\]\]?\s*$/.exec(l);
      if (h) { section = h[1]!.trim(); continue; }
      if (b === "pyproject.toml" && (section === "project.scripts" || section === "tool.poetry.scripts")) {
        const kv = /^\s*([A-Za-z0-9_.-]+)\s*=/.exec(l);
        if (kv) out.push(kv[1]!);
      }
      if (b === "cargo.toml" && section === "bin") {
        const kv = /^\s*name\s*=\s*"([^"]+)"/.exec(l);
        if (kv) out.push(kv[1]!);
      }
    }
  }
  return out;
}

/**
 * A line-level mirror of the extractor's queries (queries/*.scm and the interpreters in languages.ts of the
 * deeds plugin), for the one question tree-sitter cannot answer on a hunk fragment: does this file declare an
 * entry point anywhere we can see? Each pattern matches the head of one query's match on a single line, so a
 * handler whose body the hunk cuts off still counts. Per language:
 *   typescript/tsx/javascript  route  recv.(get|post|put|patch|delete|head|options|all)("/…", <handler or end of line>),
 *                                     recv not an HTTP client (the extractor's CLIENT_RECEIVER list)
 *                              cli    .command("name…")
 *                              ui     .addEventListener("…"), x.onclick = …, JSX on[A-Z]…={…} (tsx/javascript)
 *   python                     route  @x.(route|get|post|put|patch|delete|head|options)("/…")
 *                              cli    @x.command / @x.group, .add_parser("…")
 *                              ui     .bind("…"), x.signal.connect(…)
 *   go                         route  .(GET|…|Handle|HandleFunc)("/…" or "METHOD /…", …)
 *                              cli    a qualified Command composite literal (cobra.Command{, cli.Command{). The
 *                                     extractor also wants its Use or Name key, which may sit outside the hunk;
 *                                     both libraries' commands carry one, so the literal's head is taken as the
 *                                     command. Go's func main() is not a command to the extractor and is not here.
 *   rust                       route  #[get("/…")] and kin, .route("/…", …)
 *                              cli    Command::new("…") / App:: / SubCommand::, #[derive(… Subcommand …)]
 * Public-entry exports: on a file isPublicEntryFile accepts, a top-level (column 0) export declaration line.
 * Lines read: context, removed and added lines of every hunk, plus git's function-context text after each @@
 * (itself a line of the before-file). A section cut by the raw truncation is read as far as it goes.
 */
const ECMA_CLIENT = /(^|\.)(axios|http|https|fetch|client|api|request|superagent|got|ky|session|agent|\$http|httpClient)$/i;
export function visibleEntrySignal(language: string, publicEntry: boolean, lines: string[]): string | null {
  const ecma = language === "typescript" || language === "tsx" || language === "javascript";
  for (const raw of lines) {
    const l = raw.replace(/\s+$/, "");
    if (ecma) {
      const r = /([\w$.\])]+)\.(get|post|put|patch|delete|head|options|all)\(\s*(["'`])\/[^"'`]*\3\s*,\s*(.*)$/.exec(l);
      if (r && !ECMA_CLIENT.test(r[1]!) && /^(async\b|function\b|\(|[A-Za-z_$][\w$.]*\s*[,)]|[A-Za-z_$][\w$.]*\s*$|$)/.test(r[4]!) && !/^(opts|options|config|cfg|params|headers|init|settings)\b/i.test(r[4]!)) return `route: ${l.trim()}`;
      if (/\.command\(\s*["'`][A-Za-z0-9]/.test(l)) return `command: ${l.trim()}`;
      if (/\.addEventListener\(\s*["'`]/.test(l) || /\.on[a-z]+\s*=\s*(async\b|function\b|\(|(?!(null|undefined|true|false)\b)[A-Za-z_$][\w$.]*\s*;?$)/.test(l)) return `ui handler: ${l.trim()}`;
      if (language !== "typescript" && /\son[A-Z]\w*=\{/.test(l)) return `ui handler: ${l.trim()}`;
      if (publicEntry && /^export\s/.test(l)) return `public export: ${l.trim()}`;
    } else if (language === "python") {
      if (/^\s*@[\w.]+\.(route|get|post|put|patch|delete|head|options)\(\s*[rbuf]*["']\//.test(l)) return `route: ${l.trim()}`;
      if (/^\s*@[\w.]+\.(command|group)\b/.test(l) || /\.add_parser\(\s*[rbuf]*["']/.test(l)) return `command: ${l.trim()}`;
      if (/\.bind\(\s*[rbuf]*["']/.test(l) || /\w+\.\w+\.connect\(/.test(l)) return `ui handler: ${l.trim()}`;
      if (publicEntry && /^(async\s+def|def|class)\s+[A-Za-z]/.test(l)) return `public export: ${l.trim()}`;
    } else if (language === "go") {
      if (/\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options|Any|ANY|Handle|HandleFunc)\(\s*["`]([A-Z]+\s+)?\/[^"`]*["`]\s*,/.test(l)) return `route: ${l.trim()}`;
      if (/\b\w+\.Command\s*\{/.test(l)) return `command: ${l.trim()}`;
      if (publicEntry && (/^func\s+(\([^)]*\)\s*)?[A-Z]/.test(l) || /^(type|const|var)\s+[A-Z]/.test(l))) return `public export: ${l.trim()}`;
    } else if (language === "rust") {
      if (/#\[\s*(\w+::)?(get|post|put|patch|delete|head|options)\(\s*"\//.test(l) || /\.route\(\s*"\//.test(l)) return `route: ${l.trim()}`;
      if (/\b(Command|App|SubCommand)::(new|with_name)\(\s*"/.test(l) || /#\[derive\([^)]*\bSubcommand\b/.test(l)) return `command: ${l.trim()}`;
      if (publicEntry && /^pub\s/.test(l)) return `public export: ${l.trim()}`;
    }
  }
  return null;
}
/** Every line of a section the raw record shows: hunk function contexts, then context, removed and added lines. */
const visibleLines = (s: Section): string[] => s.hunks.flatMap((h) => [...(h.context ? [h.context] : []), ...h.lines.filter((l) => l[0] !== "\\").map((l) => l.slice(1))]);

type BoundaryResult = {
  added: Entry[];
  removed: Entry[];
  extracted: boolean;
  notExtracted: string[];
  /** Per product path: an entry point (route, command, ui handler, public-entry export) seen in its visible before or after text. */
  holdsEntry: Set<string>;
  /** Why each holdsEntry path is there, for the run log. */
  entrySeen: string[];
  /**
   * Parsed product source files whose whole text the raw record does not show and where nothing visible declares
   * an entry point: whether the file holds one (clause a of user_surface_touched) is unknown, not false.
   */
  entryUnknown: string[];
};

/** One line of one side of a hunk: its text, whether it is context or changed, and its line number in that side's file. */
type SideLine = { text: string; changed: boolean; fileLine: number };
function hunkSides(h: Hunk): { before: SideLine[]; after: SideLine[] } {
  const before: SideLine[] = [], after: SideLine[] = [];
  let o = h.oldStart, n = h.newStart;
  for (const l of h.lines) {
    const t = l.slice(1);
    if (l[0] === " ") { before.push({ text: t, changed: false, fileLine: o++ }); after.push({ text: t, changed: false, fileLine: n++ }); }
    else if (l[0] === "-") before.push({ text: t, changed: true, fileLine: o++ });
    else if (l[0] === "+") after.push({ text: t, changed: true, fileLine: n++ });
  }
  return { before, after };
}

/**
 * The raw record shows a modified file whole only when it is one hunk that starts at line 1 on both sides and
 * reaches the end of the file: git prints three context lines after the last change unless the file ends first,
 * so fewer than three trailing context lines (or a "\ No newline" marker) means the hunk reached the end.
 */
function showsWholeFile(s: Section): boolean {
  if (s.hunks.length !== 1) return false;
  const h = s.hunks[0]!;
  if (h.oldStart > 1 || h.newStart > 1) return false;
  if (h.lines.some((l) => l[0] === "\\")) return true;
  let trailing = 0;
  for (let i = h.lines.length - 1; i >= 0 && h.lines[i]![0] === " "; i--) trailing++;
  return trailing < 3;
}

const dedent = (lines: string[]): string[] => {
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(Math.min(cut, /^[ \t]*/.exec(l)![0].length)));
};

/**
 * Entries one side of one hunk contributes to the delta of a modified (or renamed or copied with changes) file.
 * The hunk is parsed on its own, never concatenated with the file's other hunks.
 *   - When both sides of the hunk parse without a syntax error, every entry the extractor finds on this side is
 *     returned; entries on context lines appear on both sides and cancel in the delta, so the hunk's delta is the
 *     extractor's own.
 *   - Otherwise error recovery can drop entries unevenly between the sides (a hunk that opens mid-JSX parses to a
 *     different subset of sibling elements before and after), so only entries anchored on this side's changed
 *     lines are returned, gathered from three windows of the same extractor: the hunk side whole, each run of
 *     consecutive changed lines dedented, and each changed line alone. A change that adds or removes an entry has
 *     that entry's anchor (route path, command name, event attribute, declared name) on a changed line, so the
 *     delta is read from the changed lines and the context lines cannot skew it. Exports from the run and line
 *     windows count only when their line starts at column 0, since a line parsed alone loses its nesting. A
 *     changed column-0 declaration line that no window reads as an export is named by topLevelDeclaration.
 * Returns also every changed line where the line-level patterns (visibleEntrySignal) see an entry point that no
 * window reported: the delta for this file cannot be trusted and the caller marks it not extracted.
 */
async function hunkSideEntries(
  x: Extractor, spec: LanguageSpec, path: string, side: SideLine[], cleanBothSides: boolean,
): Promise<{ entries: { b: Boundary; at: SideLine }[]; unread: string[] }> {
  const whole = await x.extractFile(spec, path, side.map((l) => l.text).join("\n"));
  const map = (bs: Boundary[], lines: SideLine[]) => bs.map((b) => ({ b, at: lines[b.line - 1]! })).filter((e) => e.at);
  if (cleanBothSides) return { entries: map(whole.boundaries, side), unread: [] };
  const found = new Map<string, { b: Boundary; at: SideLine }>();
  const keep = (e: { b: Boundary; at: SideLine }, nested: boolean) => {
    if (!e.at.changed) return;
    if (nested && e.b.kind === "export" && /^\s/.test(e.at.text)) return;
    found.set(`${e.at.fileLine}\u0000${e.b.kind}\u0000${e.b.name}\u0000${e.b.detail ?? ""}`, e);
  };
  for (const e of map(whole.boundaries, side)) keep(e, false);
  const runs: SideLine[][] = [];
  for (const l of side) { if (!l.changed) continue; const last = runs.at(-1); if (last && last.at(-1)!.fileLine === l.fileLine - 1) last.push(l); else runs.push([l]); }
  for (const run of runs) {
    if (run.length > 1) for (const e of map((await x.extractFile(spec, path, dedent(run.map((l) => l.text)).join("\n"))).boundaries, run)) keep(e, true);
    for (const l of run) for (const b of (await x.extractFile(spec, path, l.text.trim())).boundaries) keep({ b, at: l }, true);
  }
  // A declaration header cut from its body ("export function Button(props: {") parses to nothing in every window,
  // so a changed top-level declaration line no window read is named by the extractor's own naming rules.
  const exported = new Set([...found.values()].filter((e) => e.b.kind === "export").map((e) => e.at.fileLine));
  for (const l of side) {
    if (!l.changed || exported.has(l.fileLine)) continue;
    const d = topLevelDeclaration(spec.id, l.text);
    if (d) found.set(`${l.fileLine}\u0000export\u0000${d.name}\u0000${d.detail}`, { b: { kind: "export", name: d.name, detail: d.detail, file: path, line: l.fileLine, language: spec.id }, at: l });
  }
  const anchored = new Set([...found.values()].filter((e) => e.b.kind !== "export").map((e) => e.at.fileLine));
  const unread = side.filter((l) => l.changed && !anchored.has(l.fileLine)).map((l) => visibleEntrySignal(spec.id, false, [l.text])).filter((s): s is string => s !== null);
  return { entries: [...found.values()], unread };
}

/**
 * A column-0 declaration line named as the extractor's export interpreters name it (languages.ts in the deeds
 * plugin): ECMA `export <kind> Name` with detail function, class, const, let, var, type, interface or enum
 * (default and brace re-exports are left to the extractor); Go exported func (method Recv.Name when the receiver
 * type is exported), type (struct, interface or type), const and var; Rust pub fn, struct, enum, trait, type,
 * const, static and mod; Python def and class whose name does not start with an underscore.
 */
export function topLevelDeclaration(language: string, line: string): { name: string; detail: string } | null {
  if (/^\s/.test(line)) return null;
  if (language === "typescript" || language === "tsx" || language === "javascript") {
    const m = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|abstract\s+class|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(line);
    if (!m) return null;
    const k = m[1]!.replace(/\*$/, "");
    return { name: m[2]!, detail: k.endsWith("class") ? "class" : k };
  }
  if (language === "go") {
    const f = /^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Z]\w*)\s*[[(]/.exec(line);
    if (f) return f[1] ? (/^[A-Z]/.test(f[1]) ? { name: `${f[1]}.${f[2]}`, detail: "method" } : null) : { name: f[2]!, detail: "function" };
    const t = /^type\s+([A-Z]\w*)(?:\[[^\]]*\])?\s+(struct|interface)?/.exec(line);
    if (t) return { name: t[1]!, detail: t[2] ?? "type" };
    const cv = /^(const|var)\s+([A-Z]\w*)\b/.exec(line);
    return cv ? { name: cv[2]!, detail: cv[1]! } : null;
  }
  if (language === "rust") {
    const m = /^pub\s+(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?(fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)/.exec(line);
    return m ? { name: m[2]!, detail: m[1] === "fn" ? "function" : m[1]! } : null;
  }
  if (language === "python") {
    const m = /^(?:async\s+)?(def|class)\s+([A-Za-z]\w*)/.exec(line);
    return m ? { name: m[2]!, detail: m[1] === "class" ? "class" : "function" } : null;
  }
  return null;
}

async function boundaryDelta(views: FileView[], x: Extractor, kind: RepoKind | null): Promise<BoundaryResult> {
  const before: Entry[] = [], after: Entry[] = [];
  const notExtracted: string[] = [];
  const holdsEntry = new Set<string>();
  const entrySeen: string[] = [];
  const partlySeen: string[] = []; // parsed source files the raw record does not show whole
  const manifestEntries = manifestEntryFiles(views);
  for (const v of views) {
    // Manifest bin entries count as commands wherever the manifest sits (it is dependency_manifest, not product).
    if (["package.json", "pyproject.toml", "cargo.toml"].includes(lbase(v.path)) && v.section) {
      for (const n of manifestCommands(v.path, beforeText(v.section))) before.push({ kind: "command", name: n, file: v.path });
      for (const n of manifestCommands(v.path, afterText(v.section))) after.push({ kind: "command", name: n, file: v.path });
    }
    if (v.cls !== "source") continue;
    if (kind === "prompts" && PRODUCT_MD_EXT.has(ext(v.path))) continue; // product markdown is not parsed
    const spec = x.languageOf(v.path);
    if (!spec) { notExtracted.push(`${v.path} (no parser for ${ext(v.path) || "this file"})`); continue; }
    const wholeFile = (v.git === "A" || v.git === "D") ? v.visible : !!v.section && v.visible && showsWholeFile(v.section);
    if (!wholeFile) partlySeen.push(v.path);
    // An identical rename or copy has the same text on both sides, so its entries cancel; its text is not shown.
    if ((v.git === "R" || v.git === "C") && v.similarity === 100) continue;
    if (v.section) {
      // Clause (a) of user_surface_touched, read line by line over everything visible (see visibleEntrySignal).
      const lines = visibleLines(v.section);
      const pub = isPublicEntryFile(v.path, spec.id, lines.join("\n"), manifestEntries);
      const hit = visibleEntrySignal(spec.id, pub, lines);
      if (hit) { holdsEntry.add(v.path); entrySeen.push(`${v.path}: ${hit}`); }
    }
    if (!v.visible || !v.section) { notExtracted.push(`${v.path} (${v.section ? "its diff is cut short in" : "its diff is not in"} the raw record)`); continue; }
    const record = (bd: Boundary, into: Entry[], text: string) => {
      const e: Entry = { kind: KIND_NAME[bd.kind], name: bd.name, file: v.path };
      if (bd.kind === "export") {
        e.detail = bd.detail;
        e.publicEntry = isPublicEntryFile(v.path, bd.language, text, manifestEntries);
      }
      into.push(e);
      if (bd.kind !== "export" || e.publicEntry) { holdsEntry.add(v.path); entrySeen.push(`${v.path}: extractor ${e.kind} ${e.name}`); }
    };
    if (v.git === "A" || v.git === "D") {
      // The whole file is in the raw record: the extractor runs on it as `deeds extract` would.
      const text = v.git === "A" ? afterText(v.section) : beforeText(v.section);
      if (text.trim()) for (const bd of (await x.extractFile(spec, v.path, text)).boundaries) record(bd, v.git === "A" ? after : before, text);
      continue;
    }
    // Modified, or renamed or copied with changes: hunk by hunk (see hunkSideEntries).
    const visibleText = visibleLines(v.section).join("\n");
    const unread: string[] = [];
    for (const h of v.section.hunks) {
      const sides = hunkSides(h);
      const clean = !(await x.extractFile(spec, v.path, sides.before.map((l) => l.text).join("\n"))).hasError
        && !(await x.extractFile(spec, v.path, sides.after.map((l) => l.text).join("\n"))).hasError;
      for (const [side, into] of [[sides.before, before], [sides.after, after]] as const) {
        if (!side.some((l) => l.text.trim())) continue;
        const r = await hunkSideEntries(x, spec, v.path, side, clean);
        for (const e of r.entries) record(e.b, into, visibleText);
        unread.push(...r.unread);
      }
    }
    if (unread.length) notExtracted.push(`${v.path} (entry-like changed line the extractor could not read: ${unread[0]})`);
  }
  // Match by kind and name (and detail for exports) across all changed files, as multisets, so moves cancel.
  const key = (e: Entry) => `${e.kind}\u0000${e.name}\u0000${e.kind === "export" ? (e.detail ?? "") : ""}`;
  const count = (xs: Entry[]) => { const m = new Map<string, Entry[]>(); for (const e of xs) m.set(key(e), [...(m.get(key(e)) ?? []), e]); return m; };
  const b = count(before), a = count(after);
  const added: Entry[] = [], removed: Entry[] = [];
  for (const [k, es] of a) { const n = es.length - (b.get(k)?.length ?? 0); if (n > 0) added.push(...es.slice(es.length - n)); }
  for (const [k, es] of b) { const n = es.length - (a.get(k)?.length ?? 0); if (n > 0) removed.push(...es.slice(es.length - n)); }
  const entryUnknown = partlySeen.filter((p) => !holdsEntry.has(p));
  return { added, removed, extracted: notExtracted.length === 0, notExtracted, holdsEntry, entrySeen, entryUnknown };
}

/**
 * Line-aware head_tail cut for a field made of whole lines (boundary_delta): keep leading lines within two thirds
 * of `max` and trailing lines within the rest, joined by a code-written count of the lines left out, so the
 * engine never sees half an entry and the last line (the "not extracted" list, when there is one) survives. When
 * no whole line fits on a side, the engine request's character cut (truncateText, head_tail) applies instead.
 */
export function cutLines(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const lines = text.split("\n");
  const marker = (n: number) => `[… ${n} ${what} left out …]`;
  const room = max - marker(lines.length).length - 2; // two newlines around the marker
  const headRoom = Math.floor((room * 2) / 3);
  const head: string[] = [], tail: string[] = [];
  let used = 0;
  for (const l of lines) { if (used + l.length + (head.length ? 1 : 0) > headRoom) break; used += l.length + (head.length ? 1 : 0); head.push(l); }
  let tailUsed = 0;
  for (let i = lines.length - 1; i >= head.length; i--) {
    const l = lines[i]!;
    if (used + tailUsed + l.length + (tail.length ? 1 : 0) > room) break;
    tailUsed += l.length + (tail.length ? 1 : 0);
    tail.unshift(l);
  }
  if (!head.length || !tail.length) return truncateText(text, max, "head_tail");
  const out = [...head, marker(lines.length - head.length - tail.length), ...tail].join("\n");
  invariant(out.length <= max, `cutLines produced ${out.length} > ${max} characters`);
  return out;
}

function renderEntry(dir: "added" | "removed", e: Entry): string {
  const where = e.kind === "export" ? `, ${e.detail ?? "export"}, ${e.publicEntry ? "public entry point" : "module export"}` : "";
  return `${dir} ${e.kind} ${e.name} in ${e.file}${where}`;
}

// ── State renderers ──────────────────────────────────────────────────────────

function statusPhrase(v: FileView): string {
  switch (v.status) {
    case "renamed": return `renamed from ${v.oldPath}${v.similarity !== null && v.similarity < 100 ? ` with changes` : ""} to ${v.path}`;
    case "copied": return `copied from ${v.oldPath}${v.similarity !== null && v.similarity < 100 ? ` with changes` : ""} to ${v.path}`;
    case "published": return v.oldPath ? `published from a draft ${v.oldPath} to ${v.path}` : `published from a draft ${v.path}`;
    case "archived": return `archived ${v.oldPath} to ${v.path}`;
    case "added": return v.oldPath ? `added ${v.path} (moved in from ${v.oldPath})` : `added ${v.path}`;
    case "deleted": return v.oldPath ? `deleted ${v.oldPath} (moved out to ${v.path})` : `deleted ${v.path}`;
    default: return `modified ${v.path}`;
  }
}

function renderFiles(views: FileView[], cap: number): string {
  const ordered = [...views.filter(isProduct), ...views.filter((v) => !isProduct(v))];
  const line = (v: FileView) => `${statusPhrase(v)} [${v.cls}]`;
  const full = ordered.map(line).join("\n");
  if (full.length <= cap) return full;
  const product = views.filter(isProduct).map(line);
  const left = views.filter((v) => !isProduct(v));
  const classes = [...new Set(left.map((v) => v.cls))].join(", ");
  return [...product, `and ${left.length} non-product file(s) left out: ${classes}`].join("\n");
}

/**
 * The product diff: product-class sections only, redacted before any cut, ordered entry-point changes first, then
 * other source and app_config, then content, then assets (binary marker only). An added or deleted file over 60
 * lines keeps its first 40 and last 10 lines with a code-written omission marker. A section cut by the raw diff's
 * truncation keeps what the raw record holds and ends with a marker; a product file with no text gets a marker line.
 */
function renderProductDiff(views: FileView[], entryFiles: Set<string>): { text: string; missingLines: number; incomplete: boolean } {
  const prod = views.filter(isProduct);
  const rank = (v: FileView) => (entryFiles.has(v.path) ? 0 : v.cls === "source" || v.cls === "app_config" ? 1 : v.cls === "content" ? 2 : 3);
  const ordered = prod.map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i).map((x) => x.v);
  const parts: string[] = [];
  let missingLines = 0;
  let incomplete = false; // a product file missing from the raw record or cut by its truncation
  for (const v of ordered) {
    if (!v.section) {
      parts.push(`diff --git a/${v.oldPath ?? v.path} b/${v.path}\n[this file's diff is not in the raw record]\n`);
      missingLines += trimmedLineCount(v);
      incomplete = true;
      continue;
    }
    if (v.cls === "asset") {
      const head = v.section.text.split("\n").filter((l) => /^(diff --git|new file mode|deleted file mode|similarity index|rename (from|to)|copy (from|to)|Binary files)/.test(l));
      parts.push(head.join("\n") + "\n");
      continue;
    }
    let text = redactSecretValues(v.section.text);
    if ((v.git === "A" || v.git === "D") && v.section.hunks.length === 1) {
      const lines = text.split("\n");
      const at = lines.findIndex((l) => l.startsWith("@@"));
      const body = lines.slice(at + 1).filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
      if (at >= 0 && body.length > 60) {
        text = [...lines.slice(0, at + 1), ...body.slice(0, 40), `[… ${body.length - 50} lines omitted by deeds …]`, ...body.slice(-10)].join("\n") + "\n";
      }
    }
    if (v.section.truncated) {
      text = text.replace(/\n*$/, "\n") + `[the raw record's diff ends here; the rest of this file's diff is not in it]\n`;
      missingLines += trimmedLineCount(v);
      incomplete = true;
    }
    parts.push(text);
  }
  return { text: parts.join(""), missingLines, incomplete };
}
/** Diff lines a missing or cut file would add to the product diff after the per-file trim (estimate). */
const trimmedLineCount = (v: FileView): number => {
  const n = v.raw.added + v.raw.removed;
  return (v.git === "A" || v.git === "D") && n > 60 ? 51 : n;
};

/** Test-case names from added lines in live test-class files, deduplicated and redacted; null when no test file changed. */
function testTitles(views: FileView[]): string | null {
  const tests = views.filter((v) => v.cls === "test");
  if (!tests.length) return null;
  const titles: string[] = [];
  for (const v of tests) {
    if (!v.section) continue;
    const lines = addedLines(v.section);
    lines.forEach((l, i) => {
      for (const m of l.matchAll(/\b(?:it|test|describe)(?:\.(?:only|skip|each|todo|concurrent))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)) titles.push(m[2]!);
      const py = /^\s*(?:async\s+)?def\s+(test_\w+)/.exec(l); if (py) titles.push(py[1]!);
      const go = /^\s*func\s+(Test\w+)\s*\(/.exec(l); if (go) titles.push(go[1]!);
      if (/^\s*#\[(?:tokio::)?test\]/.test(l)) {
        const fn = lines.slice(i + 1, i + 4).map((n) => /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/.exec(n)?.[1]).find(Boolean);
        if (fn) titles.push(fn);
      }
    });
  }
  const unique = [...new Set(titles)];
  return unique.length ? redactSecretValues(unique.join("\n")) : "none found in the added test lines";
}

// ── Whitespace-only (the `git show -w` reading, from hunks) ──────────────────

/**
 * A product file's change survives `git show -w` unless every hunk's removed and added lines are the same
 * sequence once all whitespace is stripped from each line (git -w still shows added or removed blank lines, an
 * added or deleted file with content, and a binary change). A rename or copy with no hunks has nothing to show.
 */
function survivesIgnoreWhitespace(v: FileView): boolean {
  if (!v.section) return true; // text not in the raw record: cannot show it is whitespace-only
  if (v.section.binary) return true;
  if (v.section.truncated) return true;
  for (const h of v.section.hunks) {
    const rem = h.lines.filter((l) => l[0] === "-").map((l) => l.slice(1).replace(/\s+/g, ""));
    const add = h.lines.filter((l) => l[0] === "+").map((l) => l.slice(1).replace(/\s+/g, ""));
    if (rem.length !== add.length || rem.some((r, i) => r !== add[i])) return true;
  }
  return false;
}

// ── One commit ───────────────────────────────────────────────────────────────

/**
 * The facts and state for one commit. `kind` is the repository's kind (resolveRepoKind), or null when unknown
 * (the classifier then reads the repository as mixed). `stateFields` are the question system's declared state
 * fields with their caps; every field returned is declared there and within its cap.
 */
export async function computeFacts(raw: RawRecord, kind: RepoKind | null, stateFields: StateFields, opts: FactsOptions = {}): Promise<CommitFacts> {
  const x = EXTRACTOR;
  const caps = { files: stateFields.files?.max_chars ?? 2400, productDiff: stateFields.product_diff?.max_chars ?? 6000 };
  const notes: string[] = [];
  const repoExcluded = isRepoExcluded(raw.repo, opts);

  const { sections: allSections } = parseDiff(raw.diff);
  const sections = allSections.filter((s) => !isSnapshotPath(s.newPath) && !isSnapshotPath(s.oldPath));
  // A file listed in `files` with no section after a truncated section lost its text to the raw cut.
  const truncAt = allSections.findIndex((s) => s.truncated);
  const missingAfterTrunc = new Set<string>();
  if (truncAt >= 0) {
    const have = new Set(allSections.map((s) => s.newPath));
    for (const f of raw.files) if (!have.has(f.path)) missingAfterTrunc.add(f.path);
  }
  const live = buildViews(raw, kind, sections, missingAfterTrunc);
  const product = live.filter(isProduct);

  const snapshotOnly = raw.files.length > 0 && raw.files.every((f) => isSnapshotPath(f.path));
  const diffEmpty = sections.length === 0 || sections.every((s) => s.text.trim() === "");
  const parentKind = raw.parents <= 0 ? "root" : raw.parents === 1 ? "single" : "merge";

  const sourceFilesAdded = product.filter((v) => v.cls === "source" && (v.status === "added" || v.status === "published" || copiedWithChanges(v, live))).length;
  const itemsAdded = live.filter((v) => v.isItem && (v.status === "added" || v.status === "published" || copiedWithChanges(v, live))).length;
  const itemsRemoved = live.filter((v) => (v.status === "deleted" || v.status === "archived") && (v.git === "D" ? v.isItem : v.srcIsItem)).length;
  const assetOnly = product.length >= 1 && product.every((v) => v.cls === "asset");
  const contentOnlyEdit =
    product.length >= 1 &&
    product.every((v) => (v.cls === "content" || v.cls === "asset") && (v.status === "modified" || (v.status === "renamed" && (v.similarity ?? 100) < 100))) &&
    itemsAdded === 0 && itemsRemoved === 0;
  const dependencyChanged = live.some((v) => v.cls === "dependency_manifest" || v.cls === "lockfile");
  const toolingChanged = live.some((v) => v.cls === "ci_build");
  // Vacuous facts read false with no product file; product_files ≤ 0 settles every decision before they are read.
  /**
   * whitespace_only, tightened past computed_by's literal "git show -w has no hunks" (reported to the designer):
   * every product path is modified in place or renamed from a product path, at least one of them shows hunks, and
   * none survives -w. A hunk-less rename (move_or_copy_only's case), a published draft, an archived or added file
   * (an empty one included) and a copy (an added item) are never whitespace-only.
   */
  const whitespaceOnly =
    product.length >= 1 &&
    product.every((v) => v.status === "modified" || (v.status === "renamed" && v.srcCls !== null && PRODUCT_CLASSES.has(v.srcCls))) &&
    product.some((v) => (v.section?.hunks.length ?? 0) > 0) &&
    product.every((v) => !survivesIgnoreWhitespace(v));
  const moveOrCopyOnly =
    product.length >= 1 &&
    product.every((v) => (v.git === "R" || v.git === "C") && v.similarity === 100 && v.srcCls !== null && PRODUCT_CLASSES.has(v.srcCls)) &&
    itemsAdded === 0 && itemsRemoved === 0;
  /**
   * copy_detection_skipped: git warns when creations × candidate sources pass diff.renameLimit² (20000² = 4e8).
   * With --find-copies-harder the sources are the parent's whole tree, which the raw record does not carry;
   * assuming a tree of at most 100,000 files, the warning needs at least 4,000 created files. Under that it is
   * false; at or over it the builder cannot tell and returns null.
   */
  const created = live.filter((v) => v.git === "A" || v.git === "C").length;
  const copyDetectionSkipped: boolean | null = created < 4000 ? false : null;

  const bd = await boundaryDelta(live, x, kind);
  const userBoundariesAdded = bd.added.filter((e) => e.kind !== "export").length;
  const userBoundariesRemoved = bd.removed.filter((e) => e.kind !== "export").length;
  const publicExportsAdded = bd.added.filter((e) => e.kind === "export" && e.publicEntry).length;
  const publicExportsRemoved = bd.removed.filter((e) => e.kind === "export" && e.publicEntry).length;

  // user_surface_touched: (a) a product file holding an entry point, (b) app_config, (c) an item added/copied/published/deleted.
  const touchA = product.some((v) => bd.holdsEntry.has(v.path));
  const touchB = product.some((v) => v.cls === "app_config");
  const touchC = live.some((v) => (v.isItem || v.srcIsItem) && (["added", "published", "deleted", "archived"].includes(v.status) || copiedWithChanges(v, live)));
  // As computed_by: true on (a), (b) or (c); false when boundary_extracted and none holds; null otherwise. Clause (a)
  // reads what the raw record shows of each file (whole for added and deleted files, the hunks and their function
  // context for a modified one). When a parsed source file is not shown whole and nothing visible in it declares an
  // entry point, clause (a) is unknown for it, so the fact is null rather than false (departure 5 in the header).
  const userSurfaceTouched: boolean | null = touchA || touchB || touchC ? true : bd.extracted && bd.entryUnknown.length === 0 ? false : null;
  if (touchA) notes.push(`user_surface_touched (a): ${bd.entrySeen.join("; ")}`);
  if (userSurfaceTouched === null && bd.extracted) notes.push(`user_surface_touched null: not shown whole, no entry point visible: ${bd.entryUnknown.join(", ")}`);

  // ── state ──
  const product_statement = settingFor(opts.repoProducts, raw.repo);
  const profile = [kind ? KIND_SENTENCE[kind] : "", product_statement ? `Its users ${product_statement}` : ""].filter(Boolean).join(" ");
  const files = redactSecretValues(renderFiles(live, caps.files));
  const entryFiles = new Set([...bd.added, ...bd.removed].map((e) => e.file));
  const pd = renderProductDiff(live, entryFiles);
  const boundaryLines = [...bd.added.map((e) => renderEntry("added", e)), ...bd.removed.map((e) => renderEntry("removed", e))];
  const boundaryText = redactSecretValues(
    [...(boundaryLines.length ? boundaryLines : bd.notExtracted.length ? [] : ["none"]), ...(bd.notExtracted.length ? [`not extracted: ${bd.notExtracted.join("; ")}`] : [])].join("\n"),
  );
  const state: Record<string, string> = {
    repo_profile: profile,
    files,
    boundary_delta: cutLines(boundaryText, stateFields.boundary_delta?.max_chars ?? 900, "entry line(s)"),
    product_diff: pd.text,
  };
  const titles = testTitles(live);
  if (titles !== null) state.test_titles = titles;
  // Every declared field at or under its cap, cut the way the engine request cuts it (truncateText, the field's mode).
  for (const [k, v] of Object.entries(state)) {
    const field = stateFields[k];
    invariant(field, `state field ${k} is not declared in system.json`);
    if (v.length > field.max_chars) {
      notes.push(`state.${k} cut from ${v.length} to ${field.max_chars} characters (${field.truncate ?? "head"})`);
      state[k] = truncateText(v, field.max_chars, field.truncate ?? "head");
    }
  }

  /**
   * product_diff_size: characters of the built product diff (after redaction and per-file trim) against the cap.
   * When the raw record lost text to its own truncation, the missing part is estimated as the missing files'
   * trimmed line counts × the mean characters per diff line of the visible product diff (40 when none is visible).
   */
  const pdLines = pd.text.split("\n").filter(Boolean);
  const meanLine = pdLines.length ? pd.text.length / pdLines.length : 40;
  const estChars = pd.text.length + Math.round(pd.missingLines * meanLine);
  /**
   * computed_by reads fits as "the engine saw every hunk". A product file missing from the raw record or cut by its
   * truncation means the state handed to the engine lacks hunks, so such a case is never fits: it is large when
   * the visible product diff is at least a quarter of the estimated whole (computed_by's "saw at least a quarter")
   * and the estimate is within four times the cap, huge otherwise. The estimate only places the case between large
   * and huge; it can never make a case with missing text read fits.
   */
  const seenShare = estChars > 0 ? Math.min(pd.text.length, caps.productDiff) / estChars : 0;
  const productDiffSize: "fits" | "large" | "huge" = pd.incomplete
    ? estChars <= caps.productDiff * 4 && seenShare >= 0.25 ? "large" : "huge"
    : estChars <= caps.productDiff ? "fits" : estChars <= caps.productDiff * 4 ? "large" : "huge";
  if (pd.incomplete) notes.push(`product_diff_size ${productDiffSize}: text missing from the raw record; ${pd.text.length} visible + ~${Math.round(pd.missingLines * meanLine)} estimated missing chars`);

  const secretShapeRemaining = hasSecretShape(JSON.stringify(state));

  const facts: Record<string, Scalar | null> = {
    repo_excluded: repoExcluded,
    snapshot_only: snapshotOnly,
    parent_kind: parentKind,
    diff_empty: diffEmpty,
    repo_kind: kind,
    product_files: product.length,
    asset_only: assetOnly,
    source_files_added: sourceFilesAdded,
    items_added: itemsAdded,
    items_removed: itemsRemoved,
    content_only_edit: contentOnlyEdit,
    dependency_changed: dependencyChanged,
    tooling_changed: toolingChanged,
    whitespace_only: whitespaceOnly,
    move_or_copy_only: moveOrCopyOnly,
    copy_detection_skipped: copyDetectionSkipped,
    boundary_extracted: bd.extracted,
    user_boundaries_added: userBoundariesAdded,
    user_boundaries_removed: userBoundariesRemoved,
    public_exports_added: publicExportsAdded,
    public_exports_removed: publicExportsRemoved,
    user_surface_touched: userSurfaceTouched,
    product_diff_size: productDiffSize,
    secret_shape_remaining: secretShapeRemaining,
    revert_of: null, // no patch-id index and no recorded deeds for earlier commits in the raw record
    answer_set_complete: true, // design-time projection, per computed_by
  };
  return { state, facts, notes };
}
