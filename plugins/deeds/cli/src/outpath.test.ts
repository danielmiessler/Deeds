import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAnalyzeMany } from "./commands/analyze-many.ts";
import { runAnalyze, type AnalyzeDeps } from "./commands/analyze.ts";
import { DeedsError } from "./contract.ts";
import { checkOutputPath } from "./outpath.ts";

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "deeds-out-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const cwd = join(work, "project");
const elsewhere = join(work, "elsewhere");
mkdirSync(cwd);
mkdirSync(elsewhere);
writeFileSync(join(cwd, "notes.md"), "keep me\n");
writeFileSync(join(cwd, "old.html"), "<p>old</p>\n");
writeFileSync(join(elsewhere, "rc"), "keep me too\n");
symlinkSync(join(elsewhere, "rc"), join(cwd, "link.html"));
symlinkSync(elsewhere, join(cwd, "outlink"));

const code = (f: () => unknown): string | null => {
  try {
    f();
    return null;
  } catch (e) {
    return e instanceof DeedsError ? e.code : `other: ${String(e)}`;
  }
};

describe("checkOutputPath", () => {
  test("allows a new file or an existing .html file inside the working directory", () => {
    expect(checkOutputPath(cwd, "report.html", "html", false)).toBe(join(cwd, "report.html"));
    expect(checkOutputPath(cwd, "sub/new.txt", "html", false)).toBe(join(cwd, "sub/new.txt"));
    expect(checkOutputPath(cwd, "old.html", "html", false)).toBe(join(cwd, "old.html"));
    expect(checkOutputPath(cwd, "reports", "dir", false)).toBe(join(cwd, "reports"));
  });

  test("refuses paths outside the working directory", () => {
    expect(code(() => checkOutputPath(cwd, join(elsewhere, "rc"), "html", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, "../elsewhere/new.html", "html", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, "outlink/new.html", "html", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, elsewhere, "dir", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, "outlink", "dir", false))).toBe("usage");
  });

  test("refuses an existing file that is not an .html report, and symlinks", () => {
    expect(code(() => checkOutputPath(cwd, "notes.md", "html", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, "link.html", "html", false))).toBe("usage");
    expect(code(() => checkOutputPath(cwd, "notes.md", "dir", false))).toBe("usage");
  });

  test("--allow-any-output lifts the checks", () => {
    expect(checkOutputPath(cwd, join(elsewhere, "rc"), "html", true)).toBe(join(elsewhere, "rc"));
    expect(checkOutputPath(cwd, "notes.md", "html", true)).toBe(join(cwd, "notes.md"));
  });
});

describe("analyze and analyze-many refuse before doing any work", () => {
  // No transports: anything past the path check fails later and differently (no key, not a repository, no Jev).
  const deps: AnalyzeDeps = {
    env: {},
    makeModel: () => { throw new Error("no model in this test"); },
    makeJev: () => { throw new Error("no Jev in this test"); },
  };
  const run = async (f: () => Promise<unknown>) => {
    try {
      await f();
      return null;
    } catch (e) {
      return e instanceof DeedsError ? `${e.code}: ${e.message}` : `other: ${String(e)}`;
    }
  };

  test("analyze --html outside cwd", async () => {
    const r = await run(() => runAnalyze({ args: [".", "--html", join(elsewhere, "rc")], json: true, cwd }, deps));
    expect(r).toStartWith("usage: --html");
    expect(r).toContain("--allow-any-output");
    expect(readFileSync(join(elsewhere, "rc"), "utf8")).toBe("keep me too\n");
  });

  test("analyze --html over an existing non-html file", async () => {
    expect(await run(() => runAnalyze({ args: [".", "--html", "notes.md"], json: true, cwd }, deps))).toStartWith("usage: --html");
  });

  test("analyze with a safe --html gets past the check", async () => {
    expect((await run(() => runAnalyze({ args: [".", "--html", "report.html"], json: true, cwd }, deps))) ?? "ran").not.toStartWith("usage");
  });

  test("analyze-many --out outside cwd", async () => {
    writeFileSync(join(cwd, "list.txt"), ".\n");
    expect(await run(() => runAnalyzeMany({ args: ["list.txt", "--out", elsewhere], json: true, cwd }, deps))).toStartWith("usage: --out");
    expect((await run(() => runAnalyzeMany({ args: ["list.txt", "--out", "reports"], json: true, cwd }, deps))) ?? "ran").not.toStartWith("usage");
  });
});
