import config from "@/config";

export const PROXY_API_PREFIX = "/v1";
export const MODEL_ROUTER_PREFIX = `${PROXY_API_PREFIX}/model-router`;

/**
 * Body size limit for LLM proxy routes.
 * Configurable via ARCHESTRA_API_BODY_LIMIT environment variable.
 * Default: 50MB (sufficient for long conversations with 100k+ tokens).
 */
export const PROXY_BODY_LIMIT = config.api.bodyLimit;
