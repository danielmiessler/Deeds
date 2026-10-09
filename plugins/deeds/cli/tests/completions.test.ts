import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const cli = join(root, "src/cli.ts");
const python = Bun.which("python3");
const cases = [
  { line: "deeds doct\t\n", args: ["doctor"] },
  { line: "deeds analyze --mode j\t\n", args: ["analyze", "--mode", "jev"] },
  { line: "deeds analyze --mode --json j\t\n", args: ["analyze", "--mode", "--json", "jev"] },
  { line: "deeds --json analyze --vendor --allow-unsandboxed o\t\n", args: ["--json", "analyze", "--vendor", "--allow-unsandboxed", "openai"] },
  { line: "deeds analyze --mode --json --allow-unsandboxed --json f\t\n", args: ["analyze", "--mode", "--json", "--allow-unsandboxed", "--json", "full"] },
  { line: "deeds analyze --html --json repor\t\n", args: ["analyze", "--html", "--json", "report list.txt"] },
  { line: "deeds analyze --html --json repo\\ s\tchild\t\n", args: ["analyze", "--html", "--json", "repo space/child file.txt"] },
  { line: "deeds analyze-many semi\t\n", args: ["analyze-many", "semi;file.txt"] },
  { line: "deeds analyze --html --json --ju\t\n", args: ["analyze", "--html", "--json", "--junk.html"] },
  { line: "deeds analyze --model unmatch\tX\n", args: ["analyze", "--model", "unmatchX"] },
  { line: "deeds analyze --since \"last mon\tday\"\n", args: ["analyze", "--since", "last monday"] },
  { line: "deeds analyze --since '2 w\teeks ago'\n", args: ["analyze", "--since", "2 weeks ago"] },
  { line: "deeds analyze --mode \"f\t\n", args: ["analyze", "--mode", "full"] },
  { line: "deeds analyze --mode --j\tf\t\n", args: ["analyze", "--mode", "--json", "full"] },
  { line: "deeds extract --j\t\n", args: ["extract", "--json"] },
  { line: "deeds analyze --model extract --v\to\t\n", args: ["analyze", "--model", "extract", "--vendor", "openai"] },
  { line: "deeds completions z\t\n", args: ["completions", "zsh"] },
  { line: "deeds analyze --json repo\\ s\t\n", args: ["analyze", "--json", expect.stringMatching(/^repo space\/?$/)] },
  { line: "deeds extract --rev=HEAD repo\\ s\t\n", args: ["extract", "--rev=HEAD", expect.stringMatching(/^repo space\/?$/)] },
  { line: "deeds analyze-many --out --json repo\\ s\t\n", args: ["analyze-many", "--out", "--json", expect.stringMatching(/^repo space\/?$/)] },
];

for (const shell of ["bash", "zsh", "fish"]) {
  const executable = Bun.which(shell);
  test.skipIf(process.platform === "win32" || !executable || !python)(`${shell} inserts valid arguments and preserves unfinished values`, () => {
    if (!executable || !python) throw new Error("native shell test requires the shell and Python 3");
    const dir = mkdtempSync(join(tmpdir(), "deeds-completions-"));
    try {
      const generated = Bun.spawnSync([process.execPath, "--no-env-file", `--config=${join(root, "bunfig.toml")}`, cli, "completions", shell]);
      expect(generated.exitCode).toBe(0);
      const script = join(dir, "completion");
      writeFileSync(script, generated.stdout);
      for (const name of ["doctor", "jev", "openai", "repo space"]) mkdirSync(join(dir, name));
      for (const name of ["report list.txt", "semi;file.txt", "--junk.html", "repo space/child file.txt", "last monday"]) writeFileSync(join(dir, name), "");
      const result = Bun.spawnSync([python, join(import.meta.dir, "complete_in_pty.py"), executable, script, dir, JSON.stringify(cases.map((c) => c.line))], { timeout: 25_000 });
      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const observed: unknown = JSON.parse(result.stdout.toString());
      expect(observed).toEqual(cases.map((c) => c.args));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
}

test.skipIf(!Bun.which("fish"))("Fish does not select commands from filenames or option values", () => {
  const generated = Bun.spawnSync([process.execPath, "--no-env-file", `--config=${join(root, "bunfig.toml")}`, cli, "completions", "fish"]);
  expect(generated.exitCode).toBe(0);
  for (const line of ["deeds analyze-many extract --r", "deeds analyze --model extract --r"]) {
    const result = Bun.spawnSync(["fish", "--no-config", "-c", generated.stdout.toString() + `\ncomplete -C '${line}'`]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().split("\n")).not.toContain("--rev");
  }
});

test("unsupported shells fail with a usage error", () => {
  const result = Bun.spawnSync([process.execPath, "--no-env-file", `--config=${join(root, "bunfig.toml")}`, cli, "completions", "powershell", "--json"]);
  expect(result.exitCode).toBe(2);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({ error: { code: "usage" } });
});
