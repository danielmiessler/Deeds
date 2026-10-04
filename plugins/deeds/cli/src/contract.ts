/**
 * The command contract: exit codes, context, result, the Command shape and DeedsError. No I/O,
 * so a pure command can import it without gaining any I/O.
 */

export const EXIT = { ok: 0, error: 1, usage: 2, denied: 3 } as const;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface CommandContext {
  /** Arguments after the command name, with `--json` removed. */
  args: string[];
  json: boolean;
  cwd: string;
  /** The full registry, for commands such as help. */
  commands: readonly Command[];
  /**
   * Whether this process runs under an OS network denial, measured once by the CLI. Commands read it
   * here instead of probing, so a pure command never has to touch the OS to report it.
   */
  offlineEnforcement: "os-sandbox" | "in-process";
}

export interface CommandResult {
  data: JsonValue;
  /** Human rendering for non-JSON mode; falls back to pretty JSON. */
  text?: string;
}

export interface Command {
  /** Lowercase kebab-case; must equal the file name in src/commands. */
  name: string;
  summary: string;
  /** Defaults to `deeds <name>`. */
  usage?: string;
  /** "none" (default): network denied. "model": only the vendor allowlist is reachable. "model+clone": the vendors plus `git clone` from github.com (analyze). */
  network?: "none" | "model" | "model+clone";
  /**
   * True for a command that touches nothing outside this process: it spawns nothing, reads and
   * writes no files, and never uses the network (help and version). It needs no OS sandbox, so it
   * still works on a host that has none. Every other network-none command fails closed there.
   */
  pure?: boolean;
  run(ctx: CommandContext): CommandResult | Promise<CommandResult>;
}

/** Throw from a command to fail with a specific code and exit status. */
export class DeedsError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exit: number = EXIT.error,
  ) {
    super(message);
    this.name = "DeedsError";
  }
}
