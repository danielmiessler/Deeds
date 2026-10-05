import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CLI_BUNFIG, reexecArgv } from "./cli.ts";

const CLI_DIR = join(import.meta.dir, "..");
const PLUGIN_BIN = join(CLI_DIR, "..", "bin", "deeds");
const INSTALL_SH = join(CLI_DIR, "..", "..", "..", "install.sh");
const ENTRY = join(import.meta.dir, "cli.ts");

// A working directory whose bunfig.toml preloads a script that only drops a marker file beside itself.
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "deeds-bunfig-"));
const marker = join(work, "MARKER");
writeFileSync(join(work, "bunfig.toml"), 'preload = ["./mark.ts"]\n');
writeFileSync(join(work, "mark.ts"), 'require("node:fs").writeFileSync(new URL("./MARKER", import.meta.url), "ran");\n');
afterAll(() => rmSync(work, { recursive: true, force: true }));

function runIn(cmd: string[]): number {
  rmSync(marker, { force: true });
  const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
  return Bun.spawnSync(cmd, { cwd: work, env, stdout: "ignore", stderr: "ignore" }).exitCode ?? -1;
}

describe("bun config is pinned", () => {
  test("the setup itself works: a bare bun run in that directory runs the preload", () => {
    runIn([process.execPath, "--no-env-file", ENTRY, "version"]);
    expect(existsSync(marker)).toBe(true);
  });

  test("the CLI ships its own bunfig.toml with no preload", () => {
    expect(CLI_BUNFIG).toBe(join(CLI_DIR, "bunfig.toml"));
    expect(readFileSync(CLI_BUNFIG, "utf8")).not.toMatch(/^\s*preload/m);
  });

  test("the re-exec argv does not read the cwd's bunfig.toml", () => {
    const argv = reexecArgv(process.execPath, ENTRY, ["version"]);
    expect(argv).toContain(`--config=${CLI_BUNFIG}`);
    expect(runIn(argv)).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("the plugin launcher does not read the cwd's bunfig.toml", () => {
    // Skip the first-run dependency install: the stamp is what ensure_deps compares.
    const stamp = join(CLI_DIR, "node_modules", ".deeds-lock");
    if (!existsSync(stamp)) {
      const want = Bun.spawnSync(["sh", "-c", 'cat bun.lock package.json | cksum'], { cwd: CLI_DIR }).stdout.toString();
      writeFileSync(stamp, want);
    }
    expect(runIn(["sh", PLUGIN_BIN, "version"])).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  test("the launcher install.sh writes pins the config", () => {
    const sh = readFileSync(INSTALL_SH, "utf8");
    const launcher = /<<LAUNCH\n([\s\S]*?)\nLAUNCH\n/.exec(sh)?.[1] ?? "";
    expect(launcher).toContain('exec bun --no-env-file --config="$INSTALL_DIR/bunfig.toml" "$INSTALL_DIR/src/cli.ts"');
    // Render it for this checkout and run it from the hostile directory.
    const rendered = join(work, "launcher.sh");
    writeFileSync(rendered, launcher.replaceAll("$INSTALL_DIR", CLI_DIR).replaceAll("\\$@", "$@"));
    expect(runIn(["sh", rendered, "version"])).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});
