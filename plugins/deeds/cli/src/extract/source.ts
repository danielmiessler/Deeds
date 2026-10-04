/**
 * Where the files come from: a git commit, a git working tree, or a plain folder. All three apply the
 * same scope rules, so the same sources give the same answer however they are read. Read-only: nothing
 * here writes, and symlinks are never followed out of the folder.
 */
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DeedsError, EXIT } from "../contract.ts";
import { languageOf } from "./languages.ts";

export interface SourceFile {
  /** Path relative to the root, with forward slashes. */
  path: string;
  text: string;
}

export interface OpenedSource {
  /** The resolved commit id, or null when the working tree or a plain folder was read. */
  rev: string | null;
  files: SourceFile[];
}

const MAX_BYTES = 1_000_000;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "vendor", "dist", "target", "__pycache__", ".venv", "venv", "site-packages",
  "coverage", ".next", ".nuxt", "bower_components",
  // test code is not product capability
  "test", "tests", "__tests__", "__mocks__", "testdata", "fixtures",
]);
const SKIP_FILES = [
  /\.d\.[cm]?ts$/,
  /\.min\.[cm]?js$/,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
];

/** True when this path is in scope: a covered language, outside vendored, generated and test locations. */
export function inScope(path: string): boolean {
  const lang = languageOf(path);
  if (!lang) return false;
  const parts = path.split("/");
  const dirs = parts.slice(0, -1);
  if (dirs.some((d) => SKIP_DIRS.has(d))) return false;
  if (lang.privateDirs && dirs.some((d) => lang.privateDirs!.includes(d))) return false;
  return !SKIP_FILES.some((re) => re.test(path));
}

/** Minified or generated one-line files are not source worth parsing. */
function plausibleSource(text: string): boolean {
  if (text.length > MAX_BYTES) return false;
  const lines = text.split("\n").length;
  return !(text.length > 20_000 && text.length / lines > 400);
}

function git(root: string, args: string[], input?: Uint8Array): { ok: boolean; out: Buffer; err: string } {
  const p = Bun.spawnSync(["git", "-C", root, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(input ? { stdin: input } : {}),
  });
  return { ok: p.exitCode === 0, out: Buffer.from(p.stdout), err: p.stderr.toString().trim() };
}

function isWorkTree(root: string): boolean {
  const r = git(root, ["rev-parse", "--is-inside-work-tree"]);
  return r.ok && r.out.toString().trim() === "true";
}

const decoder = new TextDecoder("utf-8", { fatal: false });

function fromCommit(root: string, rev: string): OpenedSource {
  if (rev.startsWith("-")) throw new DeedsError("bad_rev", `not a revision: ${rev}`, EXIT.error);
  if (!isWorkTree(root)) throw new DeedsError("bad_rev", "--rev needs a git repository", EXIT.error);
  const resolved = git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`]);
  if (!resolved.ok) throw new DeedsError("bad_rev", `no such commit: ${rev}`, EXIT.error);
  const sha = resolved.out.toString().trim();
  const tree = git(root, ["ls-tree", "-r", "-z", sha]);
  if (!tree.ok) throw new DeedsError("error", `git ls-tree failed: ${tree.err}`, EXIT.error);
  const wanted: { path: string; oid: string }[] = [];
  for (const entry of tree.out.toString("utf8").split("\0")) {
    if (!entry) continue;
    const tab = entry.indexOf("\t");
    const [mode, type, oid] = entry.slice(0, tab).split(" ");
    const path = entry.slice(tab + 1);
    if (type === "blob" && mode !== "120000" && oid && inScope(path)) wanted.push({ path, oid });
  }
  wanted.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const files: SourceFile[] = [];
  if (wanted.length > 0) {
    const batch = git(root, ["cat-file", "--batch"], Buffer.from(wanted.map((w) => w.oid).join("\n") + "\n"));
    if (!batch.ok) throw new DeedsError("error", `git cat-file failed: ${batch.err}`, EXIT.error);
    const buf = batch.out;
    let pos = 0;
    for (const w of wanted) {
      const nl = buf.indexOf(0x0a, pos);
      const header = buf.subarray(pos, nl).toString("utf8").split(" ");
      const size = Number(header[2]);
      if (header[1] !== "blob" || !Number.isFinite(size)) throw new DeedsError("error", `unexpected cat-file header for ${w.path}`, EXIT.error);
      const text = decoder.decode(buf.subarray(nl + 1, nl + 1 + size));
      pos = nl + 1 + size + 1;
      if (plausibleSource(text)) files.push({ path: w.path, text });
    }
  }
  return { rev: sha, files };
}

function walk(root: string, rel: string, out: string[]): void {
  const entries = readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of entries) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(root, path, out);
    } else if (e.isFile() && inScope(path)) out.push(path);
  }
}

async function fromWorkingTree(root: string): Promise<OpenedSource> {
  let paths: string[];
  if (isWorkTree(root)) {
    const ls = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (!ls.ok) throw new DeedsError("error", `git ls-files failed: ${ls.err}`, EXIT.error);
    paths = [...new Set(ls.out.toString("utf8").split("\0").filter((p) => p && inScope(p)))];
  } else {
    paths = [];
    walk(root, "", paths);
  }
  paths.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files: SourceFile[] = [];
  for (const path of paths) {
    const full = join(root, path);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      continue; // listed by git but deleted from the working tree
    }
    if (!st.isFile() || st.size > MAX_BYTES) continue;
    const text = decoder.decode(await Bun.file(full).arrayBuffer());
    if (plausibleSource(text)) files.push({ path, text });
  }
  return { rev: null, files };
}

/** Read the in-scope source files of `root`: from commit `rev` when given, else from the working tree. */
export async function openSource(root: string, rev?: string): Promise<OpenedSource> {
  return rev === undefined ? fromWorkingTree(root) : fromCommit(root, rev);
}
