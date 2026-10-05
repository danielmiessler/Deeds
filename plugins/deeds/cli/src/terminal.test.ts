import { describe, expect, test } from "bun:test";
import { runCommand } from "./cli.ts";
import type { Command, CommandContext } from "./contract.ts";
import { ANSI_SEQUENCES, toText, type Line } from "./render.ts";
import { escapeControls, terminalSafe } from "./terminal.ts";

// Control characters are built at runtime so this file holds none.
const C = (n: number) => String.fromCharCode(n);
const ESC = C(0x1b);
const BEL = C(0x07);
const CSI1 = C(0x9b); // one-byte CSI
const DEL = C(0x7f);
const CLEAR = `${ESC}[2J${ESC}[H`;
const OSC52 = `${ESC}]52;c;RVhBTVBMRV9OT1RfQV9TRUNSRVQ=${BEL}`;
const HOSTILE = `Mallory${CLEAR}${OSC52}${CSI1}31m${DEL}\rX`;

/** Every control character in `s` except \n and \t. */
const controls = (s: string) => [...s].filter((c) => /[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(c));

describe("escapeControls", () => {
  test("writes C0, C1 and DEL out as visible escapes", () => {
    const out = escapeControls(HOSTILE);
    expect(controls(out)).toEqual([]);
    expect(out).toBe("Mallory\\x1b[2J\\x1b[H\\x1b]52;c;RVhBTVBMRV9OT1RfQV9TRUNSRVQ=\\x07\\x9b31m\\x7f\\x0dX");
  });

  test("keeps newlines, tabs and ordinary text", () => {
    expect(escapeControls("a\tb\nc — ✓ é")).toBe("a\tb\nc — ✓ é");
  });
});

describe("toText", () => {
  const lines: Line[] = [[{ t: "by author", s: "head" }], [{ t: HOSTILE, s: "dim" }, { t: ` ${HOSTILE}` }]];

  test("escapes repository text and keeps the renderer's own colour codes", () => {
    const out = toText(lines, true);
    const escs = out.split(ESC).length - 1;
    // Only SGR sequences from the renderer's table remain.
    const sequences = out.match(new RegExp(`${ESC}\\[[0-9;]*m`, "g")) ?? [];
    expect(sequences.length).toBe(escs);
    for (const s of sequences) expect(ANSI_SEQUENCES.has(s)).toBe(true);
    expect(out.startsWith(`${ESC}[1mby author${ESC}[0m`)).toBe(true);
    expect(out).toContain("Mallory\\x1b[2J");
  });

  test("plain text has no control characters at all", () => {
    expect(controls(toText(lines, false))).toEqual([]);
  });
});

describe("terminal output", () => {
  const ctx = (json = false): CommandContext => ({ args: [], json, cwd: process.cwd(), commands: [], offlineEnforcement: "in-process" });
  const command = (run: Command["run"]): Command => ({ name: "probe", summary: "test probe", run, pure: true }) as Command;

  test("runCommand escapes control sequences in text output but keeps renderer colours", async () => {
    const coloured = toText([[{ t: "caps", s: "cap" }]], true);
    const o = await runCommand(command(async () => ({ data: null, text: `${coloured}\nsrc/${OSC52}.ts` })), ctx());
    expect(o.stdout).toContain(coloured);
    expect(o.stdout).toContain("src/\\x1b]52;c;");
    const leftover = o.stdout.replaceAll(coloured, "");
    expect(controls(leftover.replaceAll("\n", ""))).toEqual([]);
  });

  test("failure text escapes control sequences from error messages", async () => {
    const o = await runCommand(command(async () => { throw new Error(`git failed: ${CLEAR}`); }), ctx());
    expect(controls(o.stdout.trimEnd())).toEqual([]);
    expect(o.stdout).toContain("\\x1b[2J");
  });

  test("--json output is unchanged: JSON escapes controls itself", async () => {
    const o = await runCommand(command(async () => ({ data: { author: HOSTILE }, text: HOSTILE })), ctx(true));
    expect(JSON.parse(o.stdout).data.author).toBe(HOSTILE);
  });

  test("terminalSafe lets through only the sequences it is given", () => {
    const allowed = new Set([`${ESC}[1m`]);
    expect(terminalSafe(`${ESC}[1mok${ESC}[31mno`, allowed)).toBe(`${ESC}[1mok\\x1b[31mno`);
  });
});
