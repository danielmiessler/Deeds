import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reexecArgv } from "./cli.ts";
import { gitEnv } from "./extract/source.ts";

const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "deeds-env-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("the sandbox re-exec does not load the cwd's .env", () => {
  const cwd = join(work, "repo-with-env");
  mkdirSync(cwd);
  writeFileSync(join(cwd, ".env"), "DEEDS_ENV_PROBE=EXAMPLE_NOT_A_SECRET\n");
  const probe = join(work, "probe.ts");
  writeFileSync(probe, "process.stdout.write(String(process.env.DEEDS_ENV_PROBE ?? 'unset'));\n");
  const run = (argv: string[]) => {
    const env = { ...process.env };
    delete env.DEEDS_ENV_PROBE;
    return Bun.spawnSync(argv, { cwd, env, stdout: "pipe", stderr: "ignore" }).stdout.toString();
  };

  test("the setup itself works: plain bun in that directory loads it", () => {
    expect(run([process.execPath, probe])).toBe("EXAMPLE_NOT_A_SECRET");
  });

  test("reexecArgv passes --no-env-file", () => {
    const argv = reexecArgv(process.execPath, probe, []);
    expect(argv.slice(1, 3)).toEqual(["--no-env-file", argv[2]!]);
    expect(argv[2]).toStartWith("--config=");
    expect(run(argv)).toBe("unset");
  });
});

describe("git in extract gets no injected configuration", () => {
  test("gitEnv drops git config, repository and helper variables", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      HOME: "/home/example",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/bin/true",
      GIT_CONFIG_PARAMETERS: "'core.fsmonitor'='/bin/true'",
      GIT_CONFIG_GLOBAL: "/tmp/elsewhere",
      GIT_DIR: "/tmp/elsewhere/.git",
      GIT_EXEC_PATH: "/tmp/elsewhere/bin",
      GIT_SSH_COMMAND: "/bin/true",
      GIT_AUTHOR_NAME: "kept",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/example", GIT_AUTHOR_NAME: "kept" });
  });

  test("an fsmonitor hook named through GIT_CONFIG_* does not run when extract lists files", async () => {
    const repo = join(work, "repo");
    mkdirSync(repo);
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo, ...args], { env: gitEnv(), stdout: "ignore", stderr: "ignore" });
    git("init", "-q");
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git("add", "a.ts");
    const marker = join(work, "HOOK_RAN");
    const hook = join(work, "hook.sh");
    writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
    chmodSync(hook, 0o755);

    // Bun's spawn inherits the environment the process started with, so the variables go to a fresh bun.
    const env = { ...process.env, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: hook };

    // The setup itself works: a git that inherits these variables runs the hook.
    Bun.spawnSync(["git", "-C", repo, "ls-files"], { env, stdout: "ignore", stderr: "ignore" });
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    const script = join(work, "open.ts");
    writeFileSync(script, `const { openSource } = await import(${JSON.stringify(join(import.meta.dir, "extract", "source.ts"))});\n` +
      `console.log((await openSource(${JSON.stringify(repo)})).files.map((f) => f.path).join(","));\n`);
    const out = Bun.spawnSync([process.execPath, "--no-env-file", script], { env, stdout: "pipe", stderr: "pipe" });
    expect(out.stdout.toString().trim()).toBe("a.ts");
    expect(existsSync(marker)).toBe(false);
  });
});
