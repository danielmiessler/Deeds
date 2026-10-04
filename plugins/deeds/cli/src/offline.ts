/**
 * Two layers keep the code pass offline.
 *
 * 1. OS layer (the guarantee). `osSandboxArgv` wraps a command in macOS
 *    `sandbox-exec` with `(deny network*)`. The CLI re-executes every
 *    network-none command inside it, so nothing the process or any child
 *    (curl, git, a shell) does can reach the network. Where sandbox-exec is not
 *    usable, `osSandboxAvailable()` is false and the layer is reported as
 *    absent; it is never claimed. The CLI then fails closed: a network-none
 *    command refuses to run unless `--allow-unsandboxed` is passed.
 * 2. In-process tripwire. `restrictNetwork(allowed)` makes fetch,
 *    sockets, UDP, WebSocket, Bun.connect and the common network binaries
 *    (curl, wget, nc, ssh, ...) throw NetworkDeniedError for any host not in
 *    `allowed` (loopback is always reachable), and forces `redirect: "error"`
 *    on every fetch so a redirect can never leave the allowed hosts. It turns
 *    our own mistakes into a typed error. It is a tripwire, not a boundary:
 *    `Bun.fetch` is a non-writable, non-configurable property in Bun and
 *    cannot be patched, and a shell string can smuggle a binary the name list
 *    does not know. So src/ never uses `Bun.fetch` or raw network
 *    modules, and the OS layer covers the rest.
 *
 * `restrictNetwork` returns a function that restores everything.
 */
import childProcess from "node:child_process";
import dgram from "node:dgram";
import { existsSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export class NetworkDeniedError extends Error {
  readonly code = "network_denied";
  constructor(host: string) {
    super(`network denied: ${host}`);
    this.name = "NetworkDeniedError";
  }
}

/** Set to "1" to report the OS sandbox as unavailable (tests, strict hosts). It can only tighten, never loosen. */
export const NO_OS_SANDBOX_ENV = "DEEDS_NO_OS_SANDBOX";
/** The CLI flag that lets a network-none command run on the in-process tripwire alone. */
export const ALLOW_UNSANDBOXED_FLAG = "--allow-unsandboxed";
const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const SANDBOX_PROFILE = "(version 1)(allow default)(deny network*)";

let sandboxProbe: boolean | undefined;

/** True when `path` is a sandbox-exec that can actually apply the network-denial profile here (it fails inside another sandbox). */
export function probeSandboxExec(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const r = Bun.spawnSync([path, "-p", SANDBOX_PROFILE, "/usr/bin/true"], { stdout: "ignore", stderr: "ignore" });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** True when the OS sandbox can be applied here. DEEDS_NO_OS_SANDBOX=1 forces false (it only tightens). */
export function osSandboxAvailable(): boolean {
  if (process.env[NO_OS_SANDBOX_ENV] === "1") return false;
  sandboxProbe ??= probeSandboxExec(SANDBOX_EXEC);
  return sandboxProbe;
}

/** The argv that runs `argv` with every outbound network operation denied by the OS. */
export function osSandboxArgv(argv: string[]): string[] {
  return [SANDBOX_EXEC, "-p", SANDBOX_PROFILE, ...argv];
}

let insideProbe: boolean | undefined;

/**
 * Decide from the outcome of a loopback listen on 127.0.0.1 and ::1 (null means it worked) whether the
 * OS network denial is what stopped it. Only the sandbox's own refusal counts: EPERM on both addresses,
 * on macOS, the one platform where our sandbox exists. A host that cannot listen for any other reason
 * (a restricted container, no IPv6, a full port table) is NOT treated as sandboxed, because that
 * mistake would skip the fail-closed refusal and run on the in-process tripwire alone.
 */
export function classifyLoopbackProbe(errors: readonly ({ code?: unknown } | null)[], platform: string): boolean {
  return platform === "darwin" && errors.length > 0 && errors.every((e) => e !== null && e.code === "EPERM");
}

/**
 * True only when the OS really denies this process the network. It is measured, never read from an
 * environment variable a caller could set. See classifyLoopbackProbe for what counts.
 */
export function insideOsSandbox(): boolean {
  insideProbe ??= classifyLoopbackProbe(
    ["127.0.0.1", "::1"].map((hostname) => {
      try {
        Bun.listen({ hostname, port: 0, socket: { data() {} } }).stop(true);
        return null;
      } catch (e) {
        return e as { code?: unknown };
      }
    }),
    process.platform,
  );
  return insideProbe;
}

const NETWORK_BINARIES = [
  "curl", "wget", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "sftp", "scp", "ssh", "rsync", "nmap", "ping", "dig", "nslookup", "aria2c",
];
const GIT_REMOTE_SUBCOMMANDS = ["fetch", "pull", "push", "clone", "ls-remote", "remote-update", "remote", "submodule", "archive"];
const BOUNDARY_BEFORE = "(?:^|[\\s;&|(`/])";
const BOUNDARY_AFTER = "(?=$|[\\s;&|)`])";
const NETWORK_WORD = new RegExp(`${BOUNDARY_BEFORE}(${NETWORK_BINARIES.join("|")})${BOUNDARY_AFTER}`);
const GIT_REMOTE_WORD = new RegExp(`${BOUNDARY_BEFORE}git\\s+(?:${GIT_REMOTE_SUBCOMMANDS.join("|")})${BOUNDARY_AFTER}`);

/** Name of a network program a spawn would run, or null. Handles argv arrays and shell strings. */
function networkProgram(cmd: unknown, args?: unknown): string | null {
  if (Array.isArray(cmd)) return networkProgram(String(cmd[0] ?? ""), cmd.slice(1));
  if (typeof cmd !== "string") return null;
  const base = cmd.split("/").pop() ?? "";
  if (NETWORK_BINARIES.includes(base)) return base;
  const argList = Array.isArray(args) ? args.map(String) : [];
  if (base === "git" && argList.some((a) => GIT_REMOTE_SUBCOMMANDS.includes(a))) return "git remote";
  if (/\s/.test(cmd)) {
    const m = NETWORK_WORD.exec(cmd);
    if (m) return m[1] ?? null;
    if (GIT_REMOTE_WORD.test(cmd)) return "git remote";
  }
  if (["sh", "bash", "zsh", "dash"].includes(base)) {
    for (const a of argList) {
      const m = NETWORK_WORD.exec(a);
      if (m) return m[1] ?? null;
      if (GIT_REMOTE_WORD.test(a)) return "git remote";
    }
  }
  return null;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function hostFromUrl(input: unknown): string {
  try {
    const raw = input instanceof Request ? input.url : String(input);
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return String(input);
  }
}

/** Pull the destination host out of the argument shapes Socket.connect accepts; null means a unix socket path. */
function hostFromConnectArgs(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: string; hostname?: string; path?: string };
    if (o.path !== undefined && o.host === undefined) return null;
    return (o.host ?? o.hostname ?? "localhost").toLowerCase();
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return null;
  const second = args[1];
  return typeof second === "string" ? second.toLowerCase() : "localhost";
}

/** http.request(url | options, ...) destination host. */
function hostFromRequestArgs(args: unknown[]): string | null {
  const first = args[0];
  if (typeof first === "string" || first instanceof URL) return hostFromUrl(first);
  if (typeof first === "object" && first !== null) {
    const o = first as { host?: string; hostname?: string };
    return (o.hostname ?? o.host ?? "localhost").toLowerCase();
  }
  return "localhost";
}

/** Where `deeds analyze` keeps clones of remote repositories. */
export const CLONE_ROOT = `${process.env.HOME ?? "/tmp"}/.cache/deeds/repos`;

/** Options a permitted clone may carry. Anything else (`-c`, `--config`, `--upload-pack`, `--template`, ...) can redirect the URL or run a program. */
const CLONE_OPTIONS = /^(?:--quiet|-q|--no-tags|--single-branch|--no-checkout|--bare|--filter=blob:none|--depth=\d+)$/;
/** Options a permitted fetch may carry. */
const FETCH_OPTIONS = /^(?:--quiet|-q|--no-tags|--prune)$/;
/**
 * Git subcommands that only read or reset a local repository. Under analyze's network policy every other
 * git invocation is refused unless `isAllowedGit` passes it, so a fetch hidden in `submodule`, `remote`
 * or `archive --remote` never reaches the network.
 */
const LOCAL_GIT_SUBCOMMANDS = new Set([
  "log", "show", "rev-parse", "rev-list", "reset", "diff", "cat-file", "ls-tree", "ls-files", "status", "for-each-ref", "describe", "shortlog", "blame", "merge-base", "version",
]);

/** A git argv split into its `-C` directory, subcommand and the subcommand's args; null when it is not a git argv array. */
function parseGitArgv(cmd: unknown): { dir: string | null; sub: string | undefined; rest: string[] } | null {
  if (!Array.isArray(cmd)) return null;
  const argv = cmd.map(String);
  if ((argv[0]?.split("/").pop() ?? "") !== "git") return null;
  let i = 1;
  let dir: string | null = null;
  // Only `-C <dir>` may precede the subcommand. A global `-c` config override can rewrite the remote URL
  // (insteadOf) or name a program (sshCommand), so any other leading option leaves the subcommand unknown.
  while (argv[i] === "-C") {
    dir = argv[i + 1] ?? null;
    i += 2;
  }
  if (argv[i] === undefined || argv[i]!.startsWith("-")) return { dir, sub: undefined, rest: [] };
  return { dir, sub: argv[i], rest: argv.slice(i + 1) };
}

function isCloneDir(dir: string | null): boolean {
  return dir !== null && (dir === CLONE_ROOT || dir.startsWith(CLONE_ROOT + "/")) && !dir.includes("..");
}

/**
 * True for exactly two git invocations, as argv arrays (never a shell string): `git clone <https url> [dest]`
 * whose host is in `gitHosts`, and `git -C <dir under CLONE_ROOT> fetch [origin]`, each with only a fixed
 * set of harmless options. Everything else that reaches the network stays refused.
 */
export function isAllowedGit(cmd: unknown, gitHosts: readonly string[]): boolean {
  if (gitHosts.length === 0) return false;
  const g = parseGitArgv(cmd);
  if (!g || g.sub === undefined) return false;
  const options = g.rest.filter((a) => a.startsWith("-"));
  const positional = g.rest.filter((a) => !a.startsWith("-"));
  if (g.sub === "clone") {
    if (!options.every((o) => CLONE_OPTIONS.test(o))) return false;
    const [url, dest, ...extra] = positional;
    if (url === undefined || extra.length > 0) return false;
    // The destination is a local path; a second URL-shaped argument would be a second remote.
    if (dest !== undefined && (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.includes("@"))) return false;
    try {
      const x = new URL(url);
      return x.protocol === "https:" && gitHosts.includes(x.hostname.toLowerCase()) && x.username === "" && x.password === "";
    } catch {
      return false;
    }
  }
  if (g.sub === "fetch") {
    return isCloneDir(g.dir) && options.every((o) => FETCH_OPTIONS.test(o)) && positional.every((p) => p === "origin");
  }
  return false;
}

/** `git`, or a git helper such as `git-remote-https`, as a whole word in a shell string or a path. */
const GIT_WORD = new RegExp(`${BOUNDARY_BEFORE}git(?:-[a-z-]+)?${BOUNDARY_AFTER}`);
/**
 * Environment variables that hand git config or programs to the child (`git -c` travels this way), so they
 * could rewrite a permitted URL (insteadOf, remote.origin.url) or swap the transport binary.
 */
const GIT_INJECTION_ENV = ["GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_EXEC_PATH"];

/** True when any part of a spawn names git or a git helper: an argv element whose basename is one, or a git word in a string. */
function mentionsGit(parts: readonly string[]): boolean {
  return parts.some((p) => /^git(?:-|$)/.test(p.split("/").pop() ?? "") || GIT_WORD.test(p));
}

/**
 * Under a policy that allows git network hosts (analyze), git runs only as a direct argv array (`git` first,
 * no wrapper such as `env`, `xargs` or a shell, no command string) that is a permitted clone or fetch or a
 * local read, with no config-injecting variable in its environment. Returns the refused invocation's label,
 * or null when it may run. With no git hosts allowed the ordinary network-program check applies instead.
 */
function gitPolicyRefusal(cmd: unknown, env: Record<string, string | undefined> | undefined, gitHosts: readonly string[]): string | null {
  if (gitHosts.length === 0) return null;
  const g = parseGitArgv(cmd);
  if (!g) {
    const parts = Array.isArray(cmd) ? cmd.map(String) : typeof cmd === "string" ? [cmd] : [];
    return mentionsGit(parts) ? "git outside a direct argv" : null;
  }
  const effectiveEnv = env ?? process.env;
  const injected = GIT_INJECTION_ENV.find((k) => effectiveEnv[k] !== undefined);
  if (injected !== undefined) return `git with ${injected} set`;
  if (isAllowedGit(cmd, gitHosts)) return null;
  if (g.sub !== undefined && LOCAL_GIT_SUBCOMMANDS.has(g.sub)) return null;
  return `git ${g.sub ?? "with a leading option"}`;
}

/** The `env` option of a spawn call, when one was passed. */
function envOption(options: unknown): Record<string, string | undefined> | undefined {
  if (typeof options !== "object" || options === null || Array.isArray(options)) return undefined;
  const env = (options as { env?: unknown }).env;
  return typeof env === "object" && env !== null ? (env as Record<string, string | undefined>) : undefined;
}

export function restrictNetwork(allowed: readonly string[], opts: { gitHosts?: readonly string[] } = {}): () => void {
  const gitHosts = opts.gitHosts ?? [];
  const ok = (host: string) => LOOPBACK.has(host) || allowed.includes(host);
  const restores: Array<() => void> = [];

  const realFetch = globalThis.fetch;
  const guardedFetch = ((input: unknown, init?: RequestInit) => {
    const host = hostFromUrl(input);
    if (!ok(host)) return Promise.reject(new NetworkDeniedError(host));
    // The host is checked once, so a redirect must never be followed to an unchecked one.
    const target = input instanceof Request ? new Request(input, { redirect: "error" }) : (input as Parameters<typeof fetch>[0]);
    return realFetch(target, { ...init, redirect: "error" });
  }) as typeof fetch;
  globalThis.fetch = guardedFetch;
  restores.push(() => {
    globalThis.fetch = realFetch;
  });

  const proto = net.Socket.prototype as unknown as { connect: (...a: unknown[]) => unknown };
  const realConnect = proto.connect;
  proto.connect = function patched(this: unknown, ...args: unknown[]) {
    const host = hostFromConnectArgs(args);
    if (host !== null && !ok(host)) throw new NetworkDeniedError(host);
    return realConnect.apply(this, args);
  };
  restores.push(() => {
    proto.connect = realConnect;
  });

  // Module-level entry points do not always route through Socket.prototype.connect, so guard them directly.
  const patch = (obj: object, key: string, hostOf: (args: unknown[]) => string | null) => {
    const holder = obj as Record<string, (...a: unknown[]) => unknown>;
    const real = holder[key];
    if (typeof real !== "function") return;
    holder[key] = function guarded(this: unknown, ...args: unknown[]) {
      const host = hostOf(args);
      if (host !== null && !ok(host)) throw new NetworkDeniedError(host);
      return real.apply(this, args);
    };
    restores.push(() => {
      holder[key] = real;
    });
  };
  patch(net, "connect", hostFromConnectArgs);
  patch(net, "createConnection", hostFromConnectArgs);
  patch(tls, "connect", hostFromConnectArgs);
  for (const mod of [http, https]) {
    patch(mod, "request", hostFromRequestArgs);
    patch(mod, "get", hostFromRequestArgs);
  }

  // UDP: guard the destination of every send and connect on a dgram socket.
  const dgramProto = dgram.Socket.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const key of ["send", "connect"]) {
    const real = dgramProto[key];
    if (typeof real !== "function") continue;
    dgramProto[key] = function guardedUdp(this: unknown, ...args: unknown[]) {
      // send(msg, [offset, length,] port [, address] [, cb]); connect(port [, address] [, cb]): the address is the last non-numeric string.
      const address = [...args].reverse().find((a) => typeof a === "string" && Number.isNaN(Number(a)));
      const host = (typeof address === "string" ? address : "localhost").toLowerCase();
      if (!ok(host)) throw new NetworkDeniedError(host);
      return real.apply(this, args);
    };
    restores.push(() => {
      dgramProto[key] = real;
    });
  }

  // Spawned programs: refuse the well-known network binaries (the OS sandbox is what stops the rest).
  const cp = childProcess as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync"]) {
    const real = cp[key];
    if (typeof real !== "function") continue;
    cp[key] = function guardedSpawn(this: unknown, ...args: unknown[]) {
      // (file, [args], options) is an argv; (command, options) and anything run with `shell` is a command string.
      const options = Array.isArray(args[1]) ? args[2] : args[1];
      const shell = typeof options === "object" && options !== null && Boolean((options as { shell?: unknown }).shell);
      const argv = Array.isArray(args[1]) ? [args[0], ...args[1]].map(String) : [String(args[0])];
      const form = shell || !Array.isArray(args[1]) ? argv.join(" ") : argv;
      const gitRefused = gitPolicyRefusal(form, envOption(options), gitHosts);
      if (gitRefused !== null) throw new NetworkDeniedError(`program ${gitRefused}`);
      const prog = networkProgram(args[0], args[1]);
      if (prog !== null) throw new NetworkDeniedError(`program ${prog}`);
      return real.apply(this, args);
    };
    restores.push(() => {
      cp[key] = real;
    });
  }
  const bunSpawn = Bun as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const key of ["spawn", "spawnSync"]) {
    const real = bunSpawn[key];
    if (typeof real !== "function") continue;
    bunSpawn[key] = function guardedBunSpawn(this: unknown, ...args: unknown[]) {
      const first = args[0];
      const cmd = Array.isArray(first) ? first : typeof first === "object" && first !== null ? (first as { cmd?: unknown }).cmd : first;
      const options = Array.isArray(first) ? args[1] : first;
      const gitRefused = gitPolicyRefusal(cmd, envOption(options), gitHosts);
      if (gitRefused !== null) throw new NetworkDeniedError(`program ${gitRefused}`);
      if (isAllowedGit(cmd, gitHosts)) return real.apply(this, args);
      const prog = networkProgram(cmd);
      if (prog !== null) throw new NetworkDeniedError(`program ${prog}`);
      return real.apply(this, args);
    };
    restores.push(() => {
      bunSpawn[key] = real;
    });
  }

  const realWebSocket = globalThis.WebSocket;
  class GuardedWebSocket extends realWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      const host = hostFromUrl(url);
      if (!ok(host)) throw new NetworkDeniedError(host);
      super(url, protocols as string[]);
    }
  }
  globalThis.WebSocket = GuardedWebSocket as unknown as typeof WebSocket;
  restores.push(() => {
    globalThis.WebSocket = realWebSocket;
  });

  const bunMut = Bun as unknown as { connect: (opts: { hostname?: string }) => Promise<unknown> };
  const realBunConnect = bunMut.connect;
  bunMut.connect = (opts) => {
    const host = (opts.hostname ?? "localhost").toLowerCase();
    if (!ok(host)) return Promise.reject(new NetworkDeniedError(host));
    return realBunConnect.call(Bun, opts);
  };
  restores.push(() => {
    bunMut.connect = realBunConnect;
  });

  return () => {
    for (const r of restores.reverse()) r();
  };
}

/** Deny everything except loopback. */
export function denyNetwork(): () => void {
  return restrictNetwork([]);
}
