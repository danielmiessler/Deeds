import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UNDATED_WEEK, weekOf } from "./analyze.ts";
import { listCommits, parseCommitRecords } from "./git.ts";

const US = String.fromCharCode(0x1f);
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "deeds-log-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function repoWith(names: string[], mailmap?: string): { repo: string; shas: string[] } {
  const repo = mkdtempSync(join(work, "r-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const r = Bun.spawnSync(["git", "-C", repo, ...args], { env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  run(["init", "-q"]);
  if (mailmap) {
    writeFileSync(join(repo, ".mailmap"), mailmap);
    run(["add", ".mailmap"]);
  }
  const shas: string[] = [];
  names.forEach((name, i) => {
    writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    run(["add", "."]);
    const date = `2026-09-0${i + 1}T12:00:00+00:00`;
    run(["commit", "-q", "-m", `c${i}`], {
      GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: `a${i}@example.invalid`, GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_NAME: "c", GIT_COMMITTER_EMAIL: "c@example.invalid", GIT_COMMITTER_DATE: date,
    });
    shas.push(run(["rev-parse", "HEAD"]));
  });
  return { repo, shas };
}

describe("listCommits", () => {
  test("reads ordinary commits", () => {
    const { repo, shas } = repoWith(["Ada", "Grace"]);
    const c = listCommits(repo, "2026-01-01");
    expect(c.map((x) => x.sha)).toEqual(shas);
    expect(c.map((x) => x.author)).toEqual(["Ada", "Grace"]);
    expect(c.map((x) => weekOf(x.date))).toEqual(["2026-08-31", "2026-08-31"]);
  });

  test("an author name holding 0x1f cannot move the date or break the run", () => {
    const shifted = `Mallory${US}2001-01-01T00:00:00+00:00`;
    const broken = `Eve${US}not a date`;
    const { repo, shas } = repoWith([shifted, broken, "Ada"]);
    const c = listCommits(repo, "2026-01-01");
    expect(c.map((x) => x.sha)).toEqual(shas);
    expect(c.map((x) => x.author)).toEqual([shifted, broken, "Ada"]);
    expect(c.map((x) => weekOf(x.date))).toEqual(["2026-08-31", "2026-08-31", "2026-08-31"]);
  });

  test("the same through the repository's .mailmap", () => {
    const { repo } = repoWith(["Ada"], `Mallory${US}2001-01-01T00:00:00+00:00 <a0@example.invalid>\n`);
    const c = listCommits(repo, "2026-01-01");
    expect(c).toHaveLength(1);
    expect(c[0]!.author).toBe(`Mallory${US}2001-01-01T00:00:00+00:00`);
    expect(weekOf(c[0]!.date)).toBe("2026-08-31");
  });
});

describe("parseCommitRecords and weekOf", () => {
  test("skips records whose sha or date is malformed", () => {
    const good = `${"a".repeat(40)}${US}2026-09-01T00:00:00Z${US}Ada`;
    const out = [good, `nothex${US}2026-09-01T00:00:00Z${US}X`, `${"b".repeat(40)}${US}garbage${US}Y`, `${"c".repeat(40)}`, ""].join("\0");
    expect(parseCommitRecords(out)).toEqual([{ sha: "a".repeat(40), date: "2026-09-01T00:00:00Z", author: "Ada" }]);
  });

  test("weekOf does not throw on a date it cannot read", () => {
    expect(weekOf("not a date")).toBe(UNDATED_WEEK);
    expect(weekOf("2026-10-05T09:00:00+02:00")).toBe("2026-10-05");
  });
});
