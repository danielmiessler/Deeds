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
import { allowedExtraHost } from "./egress.ts";
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
      if (v !== "jev" && v !== "fast" && v !== "full") throw new DeedsError("usage", "--mode is jev or full (fast is an alias of jev)", EXIT.usage);
      flags.mode = v === "full" ? "full" : "jev";
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
  /** OpenAI-compatible base URL for the openai vendor; default https://api.openai.com/v1. */
  baseUrl?: string;
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

/** Decide vendor, key and model for the full-model reference read (--mode full).
 * A custom OpenAI-compatible endpoint is only used when the operator explicitly chose the openai
 * vendor (`--vendor openai`): then set DEEDS_OPENAI_BASE_URL (e.g. http://pluto:40115/v1) and
 * DEEDS_ALLOW_HOST to the endpoint's host[:port], and OPENAI_API_KEY may be absent (a dummy is used).
 * An ambient DEEDS_OPENAI_BASE_URL never picks the vendor on its own, so it cannot silently
 * redirect a run that was not asked to use a custom endpoint.
 */
export function resolveModel(flags: Pick<AnalyzeFlags, "vendor" | "model">, env: Record<string, string | undefined>, home: string = env.HOME ?? homedir()): ResolvedModel {
  const keyFor = (v: Vendor) => env[KEY_ENV[v]] || configKey(v, home);
  // The base URL is read only for an explicitly-chosen openai vendor, so it configures the endpoint
  // but never selects the vendor.
  const customBaseUrl = flags.vendor === "openai" ? env.DEEDS_OPENAI_BASE_URL : undefined;
  const vendor = flags.vendor ?? (keyFor("anthropic") ? "anthropic" : keyFor("openai") ? "openai" : undefined);
  if (!vendor) throw new DeedsError("missing_key", "--mode full needs ANTHROPIC_API_KEY or OPENAI_API_KEY (or --vendor openai with DEEDS_OPENAI_BASE_URL for a custom endpoint); deeds sends each commit's diff to that model with your own key", EXIT.usage);
  let apiKey = keyFor(vendor);
  if (!apiKey) {
    // A custom endpoint does not validate the OpenAI key, so a placeholder is enough to pass the
    // client's header check; the real trust boundary is DEEDS_ALLOW_HOST, not this value.
    if (vendor === "openai" && customBaseUrl) apiKey = "deeds-local";
    else throw new DeedsError("missing_key", `--vendor ${vendor} needs ${KEY_ENV[vendor]}; deeds sends each commit's diff to that model with your own key`, EXIT.usage);
  }
  const model = flags.model ?? env.DEEDS_MODEL ?? DEFAULT_MODEL[vendor];
  let baseUrl = vendor === "openai" && customBaseUrl ? customBaseUrl : undefined;
  if (baseUrl !== undefined) {
    // Validate here, at resolution, rather than letting a bad value fail later at egress with
    // egress_refused: it must be a plain http(s) URL whose host is exactly the one the operator
    // allowed via DEEDS_ALLOW_HOST (that is the gate). Every other input is decided here, nowhere else.
    let u: URL;
    try { u = new URL(customBaseUrl); } catch { throw new DeedsError("usage", `DEEDS_OPENAI_BASE_URL is not a valid URL: ${customBaseUrl}`, EXIT.usage); }
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new DeedsError("usage", `DEEDS_OPENAI_BASE_URL must be http or https: ${customBaseUrl}`, EXIT.usage);
    // Resolve the allowed host from the same env the caller handed us, not process.env, so this
    // decides entirely from its inputs (every other input here is read from `env`).
    const allowed = allowedExtraHost(env);
    if (!allowed || u.hostname.toLowerCase() !== allowed.host) throw new DeedsError("usage", `DEEDS_OPENAI_BASE_URL host ${u.hostname} is not allowed; set DEEDS_ALLOW_HOST to that host[:port]`, EXIT.usage);
  }
  return { mode: "full", vendor, apiKey, model, baseUrl, modelId: `${vendor}:${model}` };
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
