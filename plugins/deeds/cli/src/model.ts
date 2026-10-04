/**
 * Vendor model adapters: turn a `ModelRequest` into one call to Anthropic or OpenAI through the
 * egress-checked client, which refuses any other host. The API key comes from the caller; this file
 * never reads the environment and never logs a key. Every reply carries the vendor's token usage, and a
 * rate-limited (429) or overloaded (503, 529) request retries with bounded exponential backoff.
 */
import { createModelClient, type ModelClient } from "./egress.ts";
import type { ModelFn, ModelReply } from "./classify.ts";

export type Vendor = "anthropic" | "openai";

/** Attempts per request, the first included. */
export const MAX_ATTEMPTS = 5;
/** First backoff; each retry doubles it. */
export const BASE_BACKOFF_MS = 500;
/** No single wait is longer than this, whatever Retry-After asks for. */
export const MAX_BACKOFF_MS = 20_000;
/** A request that has not answered in this long is abandoned (and fails that commit, never the run). */
export const REQUEST_TIMEOUT_MS = 120_000;

const RETRY_STATUS = new Set([429, 503, 529]);

export interface ModelOptions {
  vendor: Vendor;
  apiKey: string;
  model: string;
  client?: ModelClient;
  /** Injected in tests so backoff costs no wall time. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The wait before retry number `attempt` (1-based): Retry-After when the vendor sent one, else doubling, both capped. */
export function backoffMs(attempt: number, retryAfter: string | null): number {
  const asked = retryAfter !== null ? Number(retryAfter) * 1000 : Number.NaN;
  const ms = Number.isFinite(asked) && asked >= 0 ? asked : BASE_BACKOFF_MS * 2 ** (attempt - 1);
  return Math.min(ms, MAX_BACKOFF_MS);
}

/** POST with bounded retry on rate limits and overload. Any other failure, or the last attempt's, throws. */
async function postWithRetry(
  client: ModelClient,
  url: string,
  init: RequestInit,
  vendor: Vendor,
  sleep: (ms: number) => Promise<void>,
): Promise<Record<string, unknown>> {
  for (let attempt = 1; ; attempt++) {
    const res = await client.request(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (res.ok) {
      const doc: unknown = await res.json();
      if (typeof doc !== "object" || doc === null) throw new Error(`${vendor} reply is not a JSON object`);
      return doc as Record<string, unknown>;
    }
    if (!RETRY_STATUS.has(res.status) || attempt >= MAX_ATTEMPTS) {
      throw new Error(`${vendor} request failed with HTTP ${res.status}${attempt > 1 ? ` after ${attempt} attempts` : ""}`);
    }
    await sleep(backoffMs(attempt, res.headers.get("retry-after")));
  }
}

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

export function vendorModel(opts: ModelOptions): ModelFn {
  const client = opts.client ?? createModelClient();
  const sleep = opts.sleep ?? realSleep;
  if (opts.vendor === "anthropic") {
    return async ({ system, user }): Promise<ModelReply> => {
      const doc = (await postWithRetry(client, "https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": opts.apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: opts.model, max_tokens: 1024, system, messages: [{ role: "user", content: user }] }),
      }, "anthropic", sleep)) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
      return {
        text: (doc.content ?? []).map((b) => (b.type === "text" ? (b.text ?? "") : "")).join(""),
        usage: { input: count(doc.usage?.input_tokens), output: count(doc.usage?.output_tokens) },
      };
    };
  }
  return async ({ system, user, responseSchema }): Promise<ModelReply> => {
    const response_format = responseSchema
      ? { type: "json_schema", json_schema: { name: responseSchema.name, strict: true, schema: responseSchema.schema } }
      : { type: "json_object" };
    const doc = (await postWithRetry(client, "https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
      body: JSON.stringify({
        model: opts.model,
        response_format,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    }, "openai", sleep)) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
    return {
      text: doc.choices?.[0]?.message?.content ?? "",
      usage: { input: count(doc.usage?.prompt_tokens), output: count(doc.usage?.completion_tokens) },
    };
  };
}
