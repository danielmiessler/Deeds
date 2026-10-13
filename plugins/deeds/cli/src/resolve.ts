/**
 * Input resolution for analyze: target, mode, vendor, key, model and window, each decided
 * here and nowhere else, so every command that analyzes resolves the same way.
 * The default judge is Clef on Cloudflare Workers AI in the user's own account (CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN); `--mode fast` is an alias of it. Only `--mode full`, the full-model reference read, reaches
 * Anthropic or OpenAI.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { DeedsError, EXIT } from "./contract.ts";
import { parseGithub } from "./git.ts";
import type { Vendor } from "./model.ts";
import { ACCOUNT_ID_SHAPE, CLEF_ENV } from "./jev/client.ts";
import { REPO_KINDS, type FactsOptions, type RepoKind } from "./jev/facts.ts";

/** clef: Clef on Workers AI (the default); full: one full-model read per commit on Anthropic or OpenAI. */
export type Mode = "clef" | "full";
export const MODES: readonly Mode[] = ["clef", "full"];
export const DEFAULT_MODE: Mode = "clef";
export { CLEF_ENV };

export const KEY_ENV: Record<Vendor, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" };
export const DEFAULT_MODEL: Record<Vendor, string> = { anthropic: "claude-sonnet-5-5", openai: "gpt-5.6-terra" };

export interface AnalyzeFlags {
  target: string;
  since: string;
  until?: string;
  mode: Mode;
  vendor?: Vendor;
  model?: string;
  /** Also write a self-contained HTML report to this path. */
  html?: string;
  /** Force colour on or off; unset means colour only on a terminal without NO_COLOR. */
  color?: boolean;
  /** --allow-any-output: let --html / --out name a path outside the working directory or an existing non-report file. */
  allowAnyOutput?: boolean;
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
      if (v === "jev") throw new DeedsError("usage", "--mode jev was retired in 0.5.0; the default judge is clef (Clef on your own Cloudflare account)", EXIT.usage);
      if (v !== "clef" && v !== "fast" && v !== "full") throw new DeedsError("usage", "--mode is clef or full (fast is an alias of clef)", EXIT.usage);
      flags.mode = v === "full" ? "full" : "clef";
    } else if (a === "--vendor") {
      const v = val();
      if (v !== "anthropic" && v !== "openai") throw new DeedsError("usage", "--vendor is anthropic or openai", EXIT.usage);
      flags.vendor = v;
    } else if (a === "--model") flags.model = val();
    else if (a === "--html") flags.html = val();
    else if (a === "--color") flags.color = true;
    else if (a === "--no-color") flags.color = false;
    else if (a === "--allow-any-output") flags.allowAnyOutput = true;
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
 * The Cloudflare entry names one file holding both credentials, with optional variable names:
 *   { "keys": { "cloudflare": { "envFile": "~/.secrets/.env", "accountVar": "CLOUDFLARE_ACCOUNT_ID", "tokenVar": "CLOUDFLARE_API_TOKEN" } } }
 * The process environment wins over the config file, variable by variable.
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

export type KeyOwner = Vendor | "cloudflare";

/** The config entry for one key owner: its env file (with ~ expanded) and the entry itself, or undefined when absent. */
function configEntry(owner: KeyOwner, home: string): { file: string; entry: Record<string, unknown> } | undefined {
  const cfg = readConfig(home);
  if (!cfg) return undefined;
  const { path, doc } = cfg;
  const entry = (doc as { keys?: Record<string, unknown> }).keys?.[owner] as Record<string, unknown> | undefined;
  if (entry === undefined) return undefined;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new DeedsError("bad_config", `${path}: keys.${owner} must be an object`, EXIT.usage);
  if (typeof entry.envFile !== "string" || entry.envFile === "") throw new DeedsError("bad_config", `${path}: keys.${owner}.envFile must be a path`, EXIT.usage);
  return { file: entry.envFile.replace(/^~(?=\/|$)/, home), entry };
}

const nameOr = (v: unknown, fallback: string): string => (typeof v === "string" && v !== "" ? v : fallback);

/** A vendor key behind the config pointer `keys.<vendor>`. */
export function configKey(vendor: Vendor, home: string): string | undefined {
  const c = configEntry(vendor, home);
  return c ? readEnvFile(c.file, nameOr(c.entry.var, KEY_ENV[vendor])) : undefined;
}

/** The Cloudflare credentials behind the config pointer `keys.cloudflare`; either may be missing. */
export function configCloudflare(home: string): { accountId?: string; apiToken?: string } {
  const c = configEntry("cloudflare", home);
  if (!c) return {};
  const accountId = readEnvFile(c.file, nameOr(c.entry.accountVar, CLEF_ENV.accountId));
  const apiToken = readEnvFile(c.file, nameOr(c.entry.tokenVar, CLEF_ENV.apiToken));
  return { ...(accountId ? { accountId } : {}), ...(apiToken ? { apiToken } : {}) };
}

export interface ResolvedModel {
  mode: "full";
  vendor: Vendor;
  apiKey: string;
  model: string;
  /** `<vendor>:<model>`, what the report names. */
  modelId: string;
}

export interface ResolvedClef {
  mode: "clef";
  accountId: string;
  apiToken: string;
}

export type ResolvedJudge = ResolvedClef | ResolvedModel;

/**
 * Decide the judge for a run: Clef on the user's Cloudflare account by default, a full-model read only under
 * --mode full. Each credential comes from the environment, else from the `keys.cloudflare` config pointer; a run
 * missing either fails missing_key naming both. Neither value is ever put in an error.
 */
export function resolveJudge(flags: Pick<AnalyzeFlags, "mode" | "vendor" | "model">, env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): ResolvedJudge {
  if (flags.mode === "full") return resolveModel(flags, env, home);
  if (flags.vendor) throw new DeedsError("usage", "--vendor applies only to --mode full; the default judge is clef", EXIT.usage);
  if (flags.model) throw new DeedsError("usage", "--model applies only to --mode full; the default judge is clef", EXIT.usage);
  let fromConfig: { accountId?: string; apiToken?: string } | undefined;
  const cfg = () => (fromConfig ??= configCloudflare(home));
  const accountId = env[CLEF_ENV.accountId] || cfg().accountId;
  const apiToken = env[CLEF_ENV.apiToken] || cfg().apiToken;
  if (!accountId || !apiToken) {
    const missing = [!accountId && CLEF_ENV.accountId, !apiToken && CLEF_ENV.apiToken].filter(Boolean).join(" and ");
    throw new DeedsError(
      "missing_key",
      `set ${CLEF_ENV.accountId} and ${CLEF_ENV.apiToken} (${missing} not found): your Cloudflare account id and an API token allowed to run Workers AI, or point keys.cloudflare in ~/.config/deeds/config.json at an env file holding them; deeds sends each commit's judged state to Clef on Workers AI in your own account (or run --mode full with ANTHROPIC_API_KEY or OPENAI_API_KEY)`,
      EXIT.usage,
    );
  }
  if (!ACCOUNT_ID_SHAPE.test(accountId)) throw new DeedsError("bad_config", `${CLEF_ENV.accountId} must be your 32-character Cloudflare account id`, EXIT.usage);
  return { mode: "clef", accountId, apiToken };
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
