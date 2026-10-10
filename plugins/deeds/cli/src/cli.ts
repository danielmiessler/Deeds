#!/usr/bin/env bun
/**
 * The Deeds CLI and its command registry.
 *
 * Registering a command: add `src/commands/<name>.ts` that default-exports a
 * `Command` whose `name` equals the file name. Nothing here is edited.
 *
 * Contract (agent-first):
 * - `--json` anywhere on the line makes stdout exactly one JSON document, errors included:
 *     success  { ok: true,  command, data }
 *     failure  { ok: false, command, error: { code, message } }
 * - Exit codes are fixed, see EXIT.
 * - `deeds help --json` is the machine-readable catalog.
 * - Commands run with the network denied unless they declare `network: "model"`,
 *   and then only the vendor allowlist is reachable. Denial is enforced twice:
 *   the CLI re-executes network-none commands under an OS sandbox when one is
 *   usable (children included), and an in-process tripwire always runs. See offline.ts.
 */
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { buildCatalog, type Catalog } from "./catalog.ts";
import { type Command, type CommandContext, DeedsError, EXIT } from "./contract.ts";
import { allowedExtraHost } from "./egress.ts";
import { VENDOR_HOSTS } from "./vendors.ts";
import { ANSI_SEQUENCES } from "./render.ts";
import { terminalSafe } from "./terminal.ts";
import {
  ALLOW_UNSANDBOXED_FLAG,
  insideOsSandbox,
  NetworkDeniedError,
  osSandboxArgv,
  osSandboxAvailable,
  restrictNetwork,
} from "./offline.ts";

export const COMMANDS_DIR = join(import.meta.dir, "commands");

/**
 * The CLI's own bun config. bun reads `$cwd/bunfig.toml` unless `--config` names another file, and the cwd is
 * usually the repository being analyzed, whose `preload` entries would run before deeds. Every bun this CLI
 * starts is pinned to this file; a copy of the CLI without one gets an empty config.
 */
export const CLI_BUNFIG = existsSync(join(import.meta.dir, "..", "bunfig.toml")) ? join(import.meta.dir, "..", "bunfig.toml") : "/dev/null";

/**
 * The argv that re-runs this CLI under bun with the launchers' flags: no `.env` loading (the cwd's `.env` would
 * otherwise set the environment of the child and every git it spawns) and the config pinned (as one `--config=`
 * argument), then the entry and its arguments.
 */
export function reexecArgv(execPath: string, entry: string, argv: string[]): string[] {
  return [execPath, "--no-env-file", `--config=${CLI_BUNFIG}`, entry, ...argv];
}

const NAME_RE = /^[a-z][a-z0-9-]*$/;

/** Discover every `*.ts` command module in `dir`, validated and sorted by name. */
export async function loadCommands(dir: string = COMMANDS_DIR): Promise<Command[]> {
  if (!existsSync(dir)) return [];
  const files = [...new Bun.Glob("*.ts").scanSync({ cwd: dir })].filter((f) => !f.endsWith(".d.ts")).sort();
  const commands: Command[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const mod = (await import(join(dir, file))) as { default?: Command };
    const cmd = mod.default;
    const stem = basename(file, ".ts");
    if (!cmd || typeof cmd.name !== "string" || typeof cmd.run !== "function" || typeof cmd.summary !== "string") {
      throw new Error(`command module ${file} must default-export a Command`);
    }
    if (!NAME_RE.test(cmd.name)) throw new Error(`command name "${cmd.name}" in ${file} is not kebab-case`);
    if (cmd.name !== stem) throw new Error(`command "${cmd.name}" must live in ${cmd.name}.ts, found ${file}`);
    if (seen.has(cmd.name)) throw new Error(`duplicate command ${cmd.name}`);
    seen.add(cmd.name);
    commands.push(cmd);
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export { buildCatalog, type Catalog, DeedsError, EXIT };
export type { Command, CommandContext, CommandResult, JsonValue } from "./contract.ts";

export interface Outcome {
  exit: number;
  stdout: string;
}

function failure(json: boolean, command: string, code: string, message: string, exit: number): Outcome {
  if (json) return { exit, stdout: JSON.stringify({ ok: false, command, error: { code, message } }) + "\n" };
  // The message can carry repository text (a path, git's stderr), so its control characters are escaped.
  return { exit, stdout: terminalSafe(`deeds ${command}: ${message}`, NO_SEQUENCES) + "\n" };
}

const NO_SEQUENCES: ReadonlySet<string> = new Set();

/** Run one command under its network policy and render the outcome. Never throws. */
export async function runCommand(cmd: Command, ctx: CommandContext): Promise<Outcome> {
  // The vendor allowlist, plus the single host an operator opted in via DEEDS_ALLOW_HOST (a local model endpoint).
  const extra = cmd.network === "model" || cmd.network === "model+clone" ? allowedExtraHost() : undefined;
  const allowed = [...VENDOR_HOSTS, ...(extra ? [extra.host] : [])];
  const restore = restrictNetwork(
    allowed,
    { gitHosts: cmd.network === "model+clone" ? ["github.com"] : [] },
  );
  try {
    const result = await cmd.run(ctx);
    if (ctx.json) return { exit: EXIT.ok, stdout: JSON.stringify({ ok: true, command: cmd.name, data: result.data }) + "\n" };
    // Text output carries repository strings (author names, paths, boundary and cap names): escape every control
    // character except the renderer's own colour codes.
    return { exit: EXIT.ok, stdout: terminalSafe(result.text ?? JSON.stringify(result.data, null, 2), ANSI_SEQUENCES) + "\n" };
  } catch (err) {
    if (err instanceof NetworkDeniedError) return failure(ctx.json, cmd.name, err.code, err.message, EXIT.denied);
    if (err instanceof DeedsError) return failure(ctx.json, cmd.name, err.code, err.message, err.exit);
    const message = err instanceof Error ? err.message : String(err);
    return failure(ctx.json, cmd.name, "error", message, EXIT.error);
  } finally {
    restore();
  }
}

/** Entry point. Returns the process exit code and writes the outcome to stdout. */
export async function main(
  argv: string[],
  cwd: string = process.cwd(),
  commandsDir: string = COMMANDS_DIR,
): Promise<number> {
  const json = argv.includes("--json");
  const allowUnsandboxed = argv.includes(ALLOW_UNSANDBOXED_FLAG);
  const rest = argv.filter((a) => a !== "--json" && a !== ALLOW_UNSANDBOXED_FLAG);
  const [name, ...args] = rest;
  const enforcement = () => (insideOsSandbox() ? "os-sandbox" : "in-process") as CommandContext["offlineEnforcement"];
  const out = async (o: Outcome) => {
    await Bun.write(Bun.stdout, o.stdout);
    return o.exit;
  };

  let commands: Command[];
  try {
    commands = await loadCommands(commandsDir);
  } catch (err) {
    return out(failure(json, name ?? "", "error", err instanceof Error ? err.message : String(err), EXIT.error));
  }

  if (name === undefined || name === "--help" || name === "-h") {
    const help = commands.find((c) => c.name === "help");
    if (help && name !== undefined) return out(await runCommand(help, { args: [], json, cwd, commands, offlineEnforcement: enforcement() }));
    return out(failure(json, "", "usage", "no command given; run `deeds help`", EXIT.usage));
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) return out(failure(json, name, "usage", `unknown command "${name}"; run \`deeds help\``, EXIT.usage));
  if ((cmd.network ?? "none") === "none" && !insideOsSandbox()) {
    if (osSandboxAvailable()) {
      // Re-execute under the OS network denial so spawned children are covered too.
      const child = Bun.spawn(osSandboxArgv(reexecArgv(process.execPath, import.meta.path, argv)), {
        cwd,
        stdin: "inherit",
        stdout: "inherit",
        stderr: "inherit",
      });
      return (await child.exited) || 0;
    }
    // Fail closed: without the OS denial only the in-process tripwire would stand, so refuse unless asked.
    // A pure command does no I/O at all, so there is nothing for the sandbox to deny.
    if (!allowUnsandboxed && cmd.pure !== true) {
      return out(
        failure(
          json,
          cmd.name,
          "sandbox_unavailable",
          `no usable OS sandbox (sandbox-exec) to deny the network; refusing to run. Pass ${ALLOW_UNSANDBOXED_FLAG} to run on the in-process guard alone`,
          EXIT.denied,
        ),
      );
    }
  }
  return out(await runCommand(cmd, { args, json, cwd, commands, offlineEnforcement: enforcement() }));
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
