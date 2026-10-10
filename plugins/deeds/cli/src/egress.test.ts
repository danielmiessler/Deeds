/**
 * Egress is the only door out of the machine, and DEEDS_ALLOW_HOST is the one way to open it wider.
 * These tests pin the boundary down: the vendor hosts stay https-only, and the extra host the operator
 * names is the only thing that may use http and a custom port. A regression that lets any host through,
 * or that lets the extra host's rule leak to others, would break the tool's core promise.
 */
import { assertAllowedHost, allowedExtraHost, EgressError } from "./egress.ts";

const V = "https://api.anthropic.com/v1"; // a vendor host that must keep working no matter what

function refuse(url: string): void {
  try {
    assertAllowedHost(url);
    throw new Error(`expected refusal for ${url}`);
  } catch (e) {
    if (e instanceof EgressError) return;
    throw e;
  }
}

function allow(url: string): void {
  try {
    assertAllowedHost(url);
  } catch {
    throw new Error(`expected to allow ${url}`);
  }
}

// Restore the environment after each case so cases cannot leak into each other.
const saved = process.env.DEEDS_ALLOW_HOST;
afterEach(() => {
  if (saved === undefined) delete process.env.DEEDS_ALLOW_HOST;
  else process.env.DEEDS_ALLOW_HOST = saved;
});

describe("assertAllowedHost", () => {
  test("vendor hosts are allowed with no opt-in", () => {
    delete process.env.DEEDS_ALLOW_HOST;
    allow("https://api.anthropic.com/v1/messages");
    allow("https://api.openai.com/v1/chat/completions");
  });

  test("http is refused for vendor hosts", () => {
    delete process.env.DEEDS_ALLOW_HOST;
    refuse("http://api.openai.com/v1/chat/completions");
  });

  test("a custom port is refused for vendor hosts", () => {
    delete process.env.DEEDS_ALLOW_HOST;
    refuse("https://api.openai.com:8443/v1/chat/completions");
  });

  test("a host outside the allowlist is refused with no opt-in", () => {
    delete process.env.DEEDS_ALLOW_HOST;
    refuse("https://evil.example/v1");
  });

  test("URL with credentials is refused even for the extra host", () => {
    process.env.DEEDS_ALLOW_HOST = "pluto:40115";
    refuse("http://user@pluto:40115/v1");
  });

  test("http + custom port are allowed for the exact host the operator named", () => {
    process.env.DEEDS_ALLOW_HOST = "pluto:40115";
    allow("http://pluto:40115/v1/chat/completions");
  });

  test("the wrong port on the extra host is refused", () => {
    process.env.DEEDS_ALLOW_HOST = "pluto:40115";
    refuse("http://pluto:9999/v1");
  });

  test("the extra host's port is not a wildcard for other hosts", () => {
    process.env.DEEDS_ALLOW_HOST = "pluto:40115";
    refuse("http://otherhost:40115/v1");
  });

  test("a bare host (no port) allows that host on any port", () => {
    process.env.DEEDS_ALLOW_HOST = "pluto";
    allow("http://pluto:40115/v1");
    allow("https://pluto/v1");
  });

  test("the extra host must still be a plain host, not a scheme or path", () => {
    process.env.DEEDS_ALLOW_HOST = "http://pluto:40115"; // malformed: scheme is not a host
    // treated as absent, so the vendor posture holds
    refuse("http://pluto:40115/v1");
  });
});

describe("allowedExtraHost", () => {
  test("parses host:port", () => {
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "pluto:40115" })).toEqual({ host: "pluto", port: "40115" });
  });
  test("parses a bare host", () => {
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "pluto" })).toEqual({ host: "pluto" });
  });
  test("is undefined when unset or empty", () => {
    expect(allowedExtraHost({})).toBeUndefined();
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "" })).toBeUndefined();
  });
  test("rejects a value with a scheme, path, or bad characters", () => {
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "http://pluto:40115" })).toBeUndefined();
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "pluto:40115/" })).toBeUndefined();
    expect(allowedExtraHost({ DEEDS_ALLOW_HOST: "pluto:abc" })).toBeUndefined();
  });
});
