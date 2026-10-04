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

/** Parse `input` and return the URL only if it is https, on an allowlisted host, with no userinfo or custom port. */
export function assertAllowedHost(input: string | URL): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new EgressError(`refused: not a valid URL: ${String(input)}`);
  }
  if (url.protocol !== "https:") throw new EgressError(`refused: ${url.protocol} is not https`);
  if (url.username !== "" || url.password !== "") throw new EgressError("refused: URL carries credentials");
  if (url.port !== "") throw new EgressError(`refused: custom port ${url.port}`);
  const host = url.hostname.toLowerCase();
  if (!(VENDOR_HOSTS as readonly string[]).includes(host)) {
    throw new EgressError(`refused: host ${host} is not on the vendor allowlist`);
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
