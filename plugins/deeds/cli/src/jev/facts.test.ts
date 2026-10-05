import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { computeFacts, TEST_TITLE_CALL, type RawRecord } from "./facts.ts";
import { loadSystem } from "./system.ts";

// The differential test runs 200,000 lines through both patterns; give it room on a slow machine.
setDefaultTimeout(120_000);

// The test-title pattern as it was before it was made linear. It is the reference for the differential test and
// is only ever run on short lines, where its backtracking stays small.
const PREVIOUS_TEST_TITLE_CALL = /\b(?:it|test|describe)(?:\.(?:only|skip|each|todo|concurrent))?\s*\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;

const matches = (re: RegExp, line: string) => [...line.matchAll(re)].map((m) => [m.index, m[0], m[1], m[2]]);

/** A small seeded generator, so a failing line can be reproduced. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = ["it(", "test(", "describe(", "it.only(", "test.each(", " (", "\"", "'", "`", "\\", "\\", "\\\\", "a", "b", " ", ")", ".", "\r", "\u2028", "\n", "x\"", "\\\"", "\\'"];

describe("TEST_TITLE_CALL", () => {
  test("reads the same titles as the previous pattern on random short lines", () => {
    const next = rng(20261005);
    let diffs = 0;
    let withTitles = 0;
    // Lines whose reading needs the second (last-quote) alternative: the first one alone reads them differently.
    const ESCAPES_ONLY = new RegExp(TEST_TITLE_CALL.source.replace("|.*)\\1", ")\\1"), "g");
    expect(ESCAPES_ONLY.source).not.toBe(TEST_TITLE_CALL.source);
    let viaLastQuote = 0;
    const N = 200_000;
    for (let i = 0; i < N; i++) {
      // Most lines open a call with a quote, so the title body is what varies.
      let line = next() < 0.8 ? `${PIECES[Math.floor(next() * 5)]}${"\"'`"[Math.floor(next() * 3)]}` : "";
      const parts = 1 + Math.floor(next() * 12);
      for (let p = 0; p < parts; p++) line += PIECES[Math.floor(next() * PIECES.length)];
      const was = matches(PREVIOUS_TEST_TITLE_CALL, line);
      const now = matches(TEST_TITLE_CALL, line);
      if (was.length) withTitles++;
      if (JSON.stringify(was) !== JSON.stringify(matches(ESCAPES_ONLY, line))) viaLastQuote++;
      if (JSON.stringify(was) !== JSON.stringify(now)) {
        diffs++;
        if (diffs <= 5) console.error("differs:", JSON.stringify(line), JSON.stringify(was), JSON.stringify(now));
      }
    }
    console.log(`differential: ${N} lines, ${withTitles} with a title, ${viaLastQuote} read through the last-quote branch, ${diffs} differences`);
    expect(viaLastQuote).toBeGreaterThan(100);
    expect(withTitles).toBeGreaterThan(N / 5);
    expect(diffs).toBe(0);
  });

  test("keeps the ordinary readings", () => {
    const titles = (l: string) => [...l.matchAll(TEST_TITLE_CALL)].map((m) => m[2]);
    expect(titles(`it("adds two numbers", () => {`)).toEqual(["adds two numbers"]);
    expect(titles(`test.only('says \\'hi\\'', fn)`)).toEqual(["says \\'hi\\'"]);
    expect(titles("describe(`group`, () => { it(\"one\") })")).toEqual(["group", "one"]);
    expect(titles(`it("a\\"b")`)).toEqual(["a\\\"b"]);
    expect(titles(`it("ends in a backslash\\\\")`)).toEqual(["ends in a backslash\\\\"]);
    expect(titles(`it("never closed`)).toEqual([]);
  });

  test("stays fast on a long unterminated string of backslashes", () => {
    for (const line of [`it("${"\\".repeat(60_000)}`, `it("${"\\".repeat(59_999)}"`, `it("${"\\\"".repeat(30_000)}`, `it('${"a\\".repeat(30_000)}`]) {
      const t0 = performance.now();
      [...line.matchAll(TEST_TITLE_CALL)];
      expect(performance.now() - t0).toBeLessThan(3000);
    }
  });
});

describe("computeFacts test_titles", () => {
  const system = loadSystem();
  const raw = (lines: string[]): RawRecord => ({
    repo: "example",
    sha: "0".repeat(40),
    parents: 1,
    files: [{ path: "test/a.test.js", status: "added", added: lines.length, removed: 0 }],
    diff: [
      "diff --git a/test/a.test.js b/test/a.test.js",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/test/a.test.js",
      `@@ -0,0 +1,${lines.length} @@`,
      ...lines.map((l) => `+${l}`),
      "",
    ].join("\n"),
  });

  test("names the added test cases", async () => {
    const facts = await computeFacts(raw([`it("parses an empty file", () => {});`]), "code", system.state);
    expect(facts.state.test_titles).toBe("parses an empty file");
  });

  test("returns promptly on an unterminated title made of backslashes", async () => {
    const t0 = performance.now();
    const facts = await computeFacts(raw([`it("${"\\".repeat(80)}`]), "code", system.state);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(facts.state.test_titles).toBe("none found in the added test lines");
  });
});
