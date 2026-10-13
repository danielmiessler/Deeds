/**
 * Where Deeds sends judgment requests: Clef on Cloudflare Workers AI, in the user's own Cloudflare account.
 * Every request goes through the egress model client, whose allowlist admits api.cloudflare.com only on a Workers AI
 * run path (src/vendors.ts HOST_PATHS).
 */

/** The judge: one Workers AI model id, named here and nowhere else. */
export const CLEF_MODEL = "@cf/cloudflare/clef";
/** The model selector the request body carries: the last segment of the model id. */
export const CLEF_MODEL_NAME = CLEF_MODEL.split("/").pop()!;
/** What the cache and the report name before any reply does. */
export const CLEF_MODEL_ID = `cloudflare:${CLEF_MODEL}`;
/** The credential variables, read from the environment or behind the config pointer `keys.cloudflare`. */
export const CLEF_ENV = { accountId: "CLOUDFLARE_ACCOUNT_ID", apiToken: "CLOUDFLARE_API_TOKEN" } as const;

const WORKERS_AI_ACCOUNTS = "https://api.cloudflare.com/client/v4/accounts";
/** A Cloudflare account id: 32 hex characters. */
export const ACCOUNT_ID_SHAPE = /^[0-9a-fA-F]{32}$/;

/** The Workers AI run URL for the judge in one account. */
export function clefEndpoint(accountId: string): string {
  if (!ACCOUNT_ID_SHAPE.test(accountId)) throw new Error(`${CLEF_ENV.accountId} is not a 32-character Cloudflare account id`);
  return `${WORKERS_AI_ACCOUNTS}/${accountId}/ai/run/${CLEF_MODEL}`;
}
