/**
 * Input resolution for analyze: target, mode, vendor, key, model and window, each decided
 * here and nowhere else, so every command that analyzes resolves the same way.
 * The default judge is Jev on the user's own Jev key (TYPESAFE_API_KEY); `--mode fast` is an alias of it. Only
 * `--mode full`, the full-model reference read, reaches Anthropic or OpenAI.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { DeedsError, EXIT } from "./contract.ts";
import { parseGithub } from "./git.ts";
import type { Vendor } from "./model.ts";
import { REPO_KINDS, type FactsOptions, type RepoKind } from "./jev/facts.ts";

/** jev: the judgment API (the default); full: one full-model read per commit on Anthropic or OpenAI. */
export type Mode = "jev" | "full";
export const MODES: readonly Mode[] = ["jev", "full"];
export const DEFAULT_MODE: Mode = "jev";
/** The Jev key variable, in the environment or behind the config pointer `keys.typesafe`. */
export const JEV_ENV_VAR = "TYPESAFE_API_KEY";

export const KEY_ENV: Record<Vendor, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
export const DEFAULT_MODEL: Record<Vendor, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.6-terra" };

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
      if (v !== "jev" && v !== "fast" && v !== "full") throw new DeedsError("usage", "--mode is jev or full (fast is an alias of jev)", EXIT.usage);
      flags.mode = v === "full" ? "full" : "jev";
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
function readConfig(home: string): { path: string; doc: Record<string, unknown> } | undefined {
  const path = join(home, ".config", "deeds", "config.json");
  if (!existsSync(path)) return undefined;
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new DeedsError("bad_config", `${path} is not valid JSON`, EXIT.usage);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new DeedsError("bad_config", `${path} must hold a JSON object`, EXIT.usage);
  return { path, doc: doc as Record<string, unknown> };
}

export type KeyOwner = Vendor | "typesafe";
const ENV_OF: Record<KeyOwner, string> = { ...KEY_ENV, typesafe: JEV_ENV_VAR };

export function configKey(vendor: KeyOwner, home: string): string | undefined {
  const cfg = readConfig(home);
  if (!cfg) return undefined;
  const { path, doc } = cfg;
  const entry = (doc as { keys?: Record<string, unknown> }).keys?.[vendor] as { envFile?: unknown; var?: unknown } | undefined;
  if (entry === undefined) return undefined;
  if (typeof entry.envFile !== "string" || entry.envFile === "") throw new DeedsError("bad_config", `${path}: keys.${vendor}.envFile must be a path`, EXIT.usage);
  const file = entry.envFile.replace(/^~(?=\/|$)/, home);
  const name = typeof entry.var === "string" && entry.var !== "" ? entry.var : ENV_OF[vendor];
  return readEnvFile(file, name);
}

export interface ResolvedModel {
  mode: "full";
  vendor: Vendor;
  apiKey: string;
  model: string;
  /** `<vendor>:<model>`, what the report names. */
  modelId: string;
}

export interface ResolvedJev {
  mode: "jev";
  apiKey: string;
}

export type ResolvedJudge = ResolvedJev | ResolvedModel;

/** Decide the judge for a run: Jev on TYPESAFE_API_KEY by default, a full-model read only under --mode full. */
export function resolveJudge(flags: Pick<AnalyzeFlags, "mode" | "vendor" | "model">, env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): ResolvedJudge {
  if (flags.mode === "full") return resolveModel(flags, env, home);
  if (flags.vendor) throw new DeedsError("usage", "--vendor applies only to --mode full; the default judge is Jev", EXIT.usage);
  if (flags.model) throw new DeedsError("usage", "--model applies only to --mode full; the default judge is Jev", EXIT.usage);
  const apiKey = env[JEV_ENV_VAR] || configKey("typesafe", home);
  if (!apiKey) {
    throw new DeedsError(
      "missing_key",
      `set ${JEV_ENV_VAR} (your Jev key from typesafe.ai), or point keys.typesafe in ~/.config/deeds/config.json at it; deeds sends each commit's judged state to Jev with your own key (or run --mode full with ANTHROPIC_API_KEY or OPENAI_API_KEY)`,
      EXIT.usage,
    );
  }
  return { mode: "jev", apiKey };
}

/** Decide vendor, key and model for the full-model reference read (--mode full). */
export function resolveModel(flags: Pick<AnalyzeFlags, "vendor" | "model">, env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): ResolvedModel {
  const keyFor = (v: Vendor) => env[KEY_ENV[v]] || configKey(v, home);
  const vendor = flags.vendor ?? (keyFor("anthropic") ? "anthropic" : keyFor("openai") ? "openai" : undefined);
  if (!vendor) throw new DeedsError("missing_key", "--mode full needs ANTHROPIC_API_KEY or OPENAI_API_KEY; deeds sends each commit's diff to that model with your own key", EXIT.usage);
  const apiKey = keyFor(vendor);
  if (!apiKey) throw new DeedsError("missing_key", `--vendor ${vendor} needs ${KEY_ENV[vendor]}; deeds sends each commit's diff to that model with your own key`, EXIT.usage);
  const model = flags.model ?? env.DEEDS_MODEL ?? DEFAULT_MODEL[vendor];
  return { mode: "full", vendor, apiKey, model, modelId: `${vendor}:${model}` };
}

/**
 * Repository settings for the judgment facts, from the same config file:
 *   { "excludeRepos": ["owner/name", "prefix*"], "repoKinds": { "name": "code" }, "repoProducts": { "name": "..." } }
 */
export function repoSettings(env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): FactsOptions {
  const cfg = readConfig(home);
  if (!cfg) return {};
  const { path, doc } = cfg;
  const out: { excludeRepos?: string[]; repoKinds?: Record<string, RepoKind>; repoProducts?: Record<string, string> } = {};
  if (doc.excludeRepos !== undefined) {
    if (!Array.isArray(doc.excludeRepos) || !doc.excludeRepos.every((x) => typeof x === "string")) {
      throw new DeedsError("bad_config", `${path}: excludeRepos must be a list of repo names`, EXIT.usage);
    }
    out.excludeRepos = doc.excludeRepos as string[];
  }
  for (const key of ["repoKinds", "repoProducts"] as const) {
    const v = doc[key];
    if (v === undefined) continue;
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw new DeedsError("bad_config", `${path}: ${key} must map repo names to values`, EXIT.usage);
    for (const [name, val] of Object.entries(v)) {
      if (typeof val !== "string") throw new DeedsError("bad_config", `${path}: ${key}.${name} must be a string`, EXIT.usage);
      if (key === "repoKinds" && !(REPO_KINDS as readonly string[]).includes(val)) {
        throw new DeedsError("bad_config", `${path}: repoKinds.${name} must be one of ${REPO_KINDS.join(", ")}`, EXIT.usage);
      }
    }
    if (key === "repoKinds") out.repoKinds = v as Record<string, RepoKind>;
    else out.repoProducts = v as Record<string, string>;
  }
  return out;
}
