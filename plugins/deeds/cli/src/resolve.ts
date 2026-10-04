/**
 * Input resolution for analyze: target, mode, vendor, key, model and window, each decided
 * here and nowhere else, so every command that analyzes resolves the same way.
 * Fast mode runs on OpenAI only, because it needs strict json_schema replies; full mode may use either.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { DeedsError, EXIT } from "./contract.ts";
import { parseGithub } from "./git.ts";
import type { Vendor } from "./model.ts";

export type Mode = "fast" | "full";
export const MODES: readonly Mode[] = ["fast", "full"];
export const DEFAULT_MODE: Mode = "fast";

export const KEY_ENV: Record<Vendor, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
export const DEFAULT_MODEL: Record<Mode, Record<Vendor, string>> = {
  fast: { openai: "gpt-5.6-terra", anthropic: "claude-sonnet-5-5" },
  full: { anthropic: "claude-sonnet-5-5", openai: "gpt-5.6-terra" },
};

export interface AnalyzeFlags {
  target: string;
  since: string;
  until?: string;
  mode: Mode;
  vendor?: Vendor;
  model?: string;
}

/** Parse analyze's argv. Pure. */
export function parseAnalyzeArgs(args: string[]): AnalyzeFlags {
  const flags: AnalyzeFlags = { target: ".", since: "90d", mode: DEFAULT_MODE };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const val = () => {
      const v = args[++i];
      if (!v) throw new DeedsError("usage", `${a} needs a value`, EXIT.usage);
      return v;
    };
    if (a === "--since") flags.since = val();
    else if (a === "--until") flags.until = val();
    else if (a === "--mode") {
      const v = val();
      if (v !== "fast" && v !== "full") throw new DeedsError("usage", "--mode is fast or full", EXIT.usage);
      flags.mode = v;
    } else if (a === "--vendor") {
      const v = val();
      if (v !== "anthropic" && v !== "openai") throw new DeedsError("usage", "--vendor is anthropic or openai", EXIT.usage);
      flags.vendor = v;
    } else if (a === "--model") flags.model = val();
    else if (a.startsWith("-")) throw new DeedsError("usage", `unknown option ${a}`, EXIT.usage);
    else flags.target = a;
  }
  return flags;
}

/** "90d", "2w", "6m", "1y", "all", or anything git's --since understands. */
export function toSince(window: string): string {
  if (window === "all") return "1970-01-01";
  const m = /^(\d+)([dwmy])$/.exec(window);
  if (!m) return window;
  const unit = { d: "days", w: "weeks", m: "months", y: "years" }[m[2] as "d" | "w" | "m" | "y"];
  return `${m[1]} ${unit} ago`;
}

export type Target = { kind: "github"; owner: string; repo: string; url: string; label: string } | { kind: "local"; path: string; label: string };

/** A GitHub URL or a local folder. Existence and repo checks for a folder happen here. */
export function resolveTarget(target: string, cwd: string, isRepo: (p: string) => boolean): Target {
  const gh = parseGithub(target);
  if (gh) return { kind: "github", ...gh, label: `github.com/${gh.owner}/${gh.repo}` };
  const path = resolvePath(cwd, target);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new DeedsError("not_found", `no such folder: ${target}`, EXIT.error);
  if (!isRepo(path)) throw new DeedsError("not_a_repo", `${target} is not a git repository`, EXIT.error);
  return { kind: "local", path, label: path };
}

/** Read one variable out of a dotenv-style file. Returns undefined when the file or variable is absent. */
export function readEnvFile(path: string, name: string): string | undefined {
  if (!existsSync(path)) return undefined;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || m[1] !== name) continue;
    const v = m[2]!.replace(/^(['"])(.*)\1$/, "$2");
    return v === "" ? undefined : v;
  }
  return undefined;
}

/**
 * `~/.config/deeds/config.json` may point a vendor's key at a variable inside an env file:
 *   { "keys": { "openai": { "envFile": "~/.secrets/.env", "var": "OPENAI_API_KEY" } } }
 * The process environment wins over the config file.
 */
export function configKey(vendor: Vendor, home: string): string | undefined {
  const path = join(home, ".config", "deeds", "config.json");
  if (!existsSync(path)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DeedsError("bad_config", `${path} is not valid JSON`, EXIT.usage);
  }
  const entry = (doc as { keys?: Record<string, unknown> } | null)?.keys?.[vendor] as { envFile?: unknown; var?: unknown } | undefined;
  if (entry === undefined) return undefined;
  if (typeof entry.envFile !== "string" || entry.envFile === "") throw new DeedsError("bad_config", `${path}: keys.${vendor}.envFile must be a path`, EXIT.usage);
  const file = entry.envFile.replace(/^~(?=\/|$)/, home);
  const name = typeof entry.var === "string" && entry.var !== "" ? entry.var : KEY_ENV[vendor];
  return readEnvFile(file, name);
}

export interface ResolvedModel {
  mode: Mode;
  vendor: Vendor;
  apiKey: string;
  model: string;
  /** `<vendor>:<model>`, what the report names. */
  modelId: string;
}

/** Decide vendor, key and model for a mode from the flags, the environment and the user config. */
export function resolveModel(flags: Pick<AnalyzeFlags, "mode" | "vendor" | "model">, env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): ResolvedModel {
  const keyFor = (v: Vendor) => env[KEY_ENV[v]] || configKey(v, home);
  let vendor: Vendor;
  if (flags.mode === "fast") {
    if (flags.vendor === "anthropic") throw new DeedsError("usage", "fast mode runs on OpenAI; use --mode full for Anthropic", EXIT.usage);
    vendor = "openai";
  } else {
    const found = flags.vendor ?? (keyFor("anthropic") ? "anthropic" : keyFor("openai") ? "openai" : undefined);
    if (!found) throw new DeedsError("missing_key", "set ANTHROPIC_API_KEY or OPENAI_API_KEY; deeds sends each commit's diff to that model with your own key", EXIT.usage);
    vendor = found;
  }
  const apiKey = keyFor(vendor);
  if (!apiKey) {
    const why = flags.mode === "fast" ? "fast mode (the default) needs" : `--vendor ${vendor} needs`;
    throw new DeedsError("missing_key", `${why} ${KEY_ENV[vendor]}; deeds sends each commit's diff to that model with your own key${flags.mode === "fast" ? " (or run --mode full with ANTHROPIC_API_KEY)" : ""}`, EXIT.usage);
  }
  const model = flags.model ?? env.DEEDS_MODEL ?? DEFAULT_MODEL[flags.mode][vendor];
  return { mode: flags.mode, vendor, apiKey, model, modelId: `${vendor}:${model}` };
}
