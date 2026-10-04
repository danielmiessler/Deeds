/**
 * Read-only git access for analyze: list the commits in a window and read each one's diff. Every call is
 * an argv array (no shell), and nothing here writes to the repository being analyzed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { CLONE_ROOT } from "./offline.ts";
import { DeedsError, EXIT } from "./contract.ts";

export interface CommitInfo {
  sha: string;
  /** Author name after the repo's .mailmap is applied. */
  author: string;
  /** Author date, ISO 8601. */
  date: string;
}

/** Largest diff sent for one commit; the rest is cut and the cut is stated in the diff itself. */
export const MAX_DIFF_BYTES = 60_000;

function git(repo: string, args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new DeedsError("git_failed", `git ${args[0]} failed: ${r.stderr.toString().trim()}`, EXIT.error);
  return r.stdout.toString();
}

/** True when `path` is inside a git work tree. */
export function isRepo(path: string): boolean {
  const r = Bun.spawnSync(["git", "-C", path, "rev-parse", "--is-inside-work-tree"], { stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 && r.stdout.toString().trim() === "true";
}

/** Parse `github.com/owner/repo` in any of its usual spellings; null when it isn't one. */
export function parseGithub(target: string): { owner: string; repo: string; url: string } | null {
  const m = /^(?:https:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(target.trim());
  if (!m) return null;
  const [, owner, repo] = m as unknown as [string, string, string];
  // `.` and `..` are legal in the pattern but would walk the clone path out of the cache.
  if ([owner, repo].some((s) => s === "." || s === "..")) return null;
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

/** Clone a GitHub repository into the cache, or fetch it when it is already there. Returns the local path. */
export function cloneOrFetch(gh: { owner: string; repo: string; url: string }): string {
  const dest = join(CLONE_ROOT, gh.owner, gh.repo);
  if (existsSync(join(dest, ".git"))) {
    const r = Bun.spawnSync(["git", "-C", dest, "fetch", "--quiet", "origin"], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new DeedsError("git_failed", `could not update ${gh.owner}/${gh.repo}: ${r.stderr.toString().trim()}`, EXIT.error);
    Bun.spawnSync(["git", "-C", dest, "reset", "--quiet", "--hard", "origin/HEAD"], { stdout: "ignore", stderr: "ignore" });
    return dest;
  }
  mkdirSync(join(CLONE_ROOT, gh.owner), { recursive: true });
  const r = Bun.spawnSync(["git", "clone", "--quiet", "--filter=blob:none", gh.url, dest], { stdout: "ignore", stderr: "pipe" });
  if (r.exitCode !== 0) throw new DeedsError("git_failed", `could not clone ${gh.owner}/${gh.repo}: ${r.stderr.toString().trim()}`, EXIT.error);
  return dest;
}

/**
 * Every commit authored inside the window on the current branch, merges included, oldest first. A merge's
 * diff (see commitDiff) holds only what the merge itself changed, so a change that arrives through a merge
 * is still counted once, at the commit that made it.
 */
export function listCommits(repo: string, since: string, until?: string): CommitInfo[] {
  const args = ["log", "--reverse", "--use-mailmap", `--since=${since}`, "--format=%H%x1f%aN%x1f%aI"];
  if (until) args.push(`--until=${until}`);
  return git(repo, args)
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, author, date] = line.split("\x1f") as [string, string, string];
      return { sha, author, date };
    });
}

/**
 * The files and unified diff of one commit (no message, no author: the classifier judges the diff only).
 * For a merge, git shows the combined diff: empty for a clean merge, only the conflict resolution otherwise.
 */
export function commitDiff(repo: string, sha: string): { files: string[]; diff: string } {
  const files = git(repo, ["show", "--format=", "--name-only", sha]).split("\n").filter(Boolean);
  let diff = git(repo, ["show", "--format=", "--no-color", "--unified=3", sha]);
  if (diff.length > MAX_DIFF_BYTES) diff = diff.slice(0, MAX_DIFF_BYTES) + `\n... diff cut at ${MAX_DIFF_BYTES} bytes of ${diff.length}\n`;
  return { files, diff };
}
