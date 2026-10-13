/** Trusted model hosts for source-derived payloads: Anthropic, OpenAI and Cloudflare Workers AI. Constants only, so any module may import it. */
export const VENDOR_HOSTS = ["api.anthropic.com", "api.openai.com", "api.cloudflare.com"] as const;
/**
 * Hosts admitted only on certain paths. api.cloudflare.com serves the whole Cloudflare API; deeds may reach it only
 * to run a Workers AI model in one account: `/client/v4/accounts/<32-hex account id>/ai/run/@cf/<org>/<model>`.
 */
export const HOST_PATHS: Readonly<Record<string, RegExp>> = {
  "api.cloudflare.com": /^\/client\/v4\/accounts\/[0-9a-fA-F]{32}\/ai\/run\/@cf\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9._-]*$/,
};
