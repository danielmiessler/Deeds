/**
 * The only door out of the machine. The semantic pass talks to a model through
 * `createModelClient`, which refuses any host outside the vendor allowlist.
 * Everything else in Deeds runs with the network denied (see offline.ts).
 */

import { VENDOR_HOSTS } from "./vendors.ts";

export { VENDOR_HOSTS };

export class EgressError extends Error {
  readonly code = "egress_refused";
  constructor(message: string) {
    super(message);
    this.name = "EgressError";
  }
}

/**
 * `DEEDS_ALLOW_HOST` opts one host in beyond the vendor allowlist, as `host` (any port)
 * or `host:port` (only that port), e.g. `pluto:40115` for a local OpenAI-compatible endpoint.
 * For that host, http and a custom port are accepted; everything else keeps the
 * https-only, port-443 posture. Read from the process environment at call time.
 */
export function allowedExtraHost(env: Record<string, string | undefined> = process.env): { host: string; port?: string } | undefined {
  const raw = env.DEEDS_ALLOW_HOST;
  if (typeof raw !== "string" || raw === "") return undefined;
  const m = /^(?<h>[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*):?(?<p>\d+)?$/i.exec(raw.trim());
  if (!m) return undefined;
  return { host: m.groups!.h!.toLowerCase(), ...(m.groups.p ? { port: m.groups.p } : {}) };
}

/** Parse `input` and return the URL only if it is allowed: https, on an allowlisted host, no userinfo, no custom port — or on the host opted in by DEEDS_ALLOW_HOST. */
export function assertAllowedHost(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressError(`refused: not a valid URL: ${String(input)}`);
  }
  if (url.username !== "" || url.password !== "") throw new EgressError("refused: URL carries credentials");
  const host = url.hostname.toLowerCase();
  const extra = allowedExtraHost();
  const onExtra = extra !== undefined && (extra.port === undefined ? host === extra.host : host === extra.host && url.port === extra.port);
  if (!onExtra) {
    if (!(VENDOR_HOSTS as readonly string[]).includes(host)) {
      throw new EgressError(`refused: host ${host} is not on the vendor allowlist${extra ? ` (DEEDS_ALLOW_HOST=${extra.host}${extra.port ? `:${extra.port}` : ""})` : ""}`);
    }
    if (url.protocol !== "https:") throw new EgressError(`refused: ${url.protocol} is not https`);
    if (url.port !== "") throw new EgressError(`refused: custom port ${url.port}`);
  }
  return url;
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface ModelClient {
  request(url: string | URL, init?: RequestInit): Promise<Response>;
}

/** A fetch wrapper that checks the host before any bytes leave, and never follows a redirect off-host. */
export function createModelClient(opts: { fetchImpl?: FetchLike } = {}): ModelClient {
  const doFetch: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  return {
    async request(url, init) {
      const checked = assertAllowedHost(url);
      return doFetch(checked.href, { ...init, redirect: "error" });
    },
  };
}
