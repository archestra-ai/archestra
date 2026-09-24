import config from "@/config";

export const PROXY_API_PREFIX = "/v1";
export const MODEL_ROUTER_PREFIX = `${PROXY_API_PREFIX}/model-router`;
export const CHAT_COMPLETIONS_SUFFIX = "/chat/completions";
export const RESPONSES_SUFFIX = "/responses";
export const RESPONSES_COMPACT_SUFFIX = "/responses/compact";
export const EMBEDDINGS_SUFFIX = "/embeddings";
export const OPENAI_HANDLED_ENDPOINT_SUFFIXES = [
  CHAT_COMPLETIONS_SUFFIX,
  RESPONSES_SUFFIX,
  RESPONSES_COMPACT_SUFFIX,
  EMBEDDINGS_SUFFIX,
] as const;

/**
 * Body size limit for LLM proxy routes.
 * Configurable via ARCHESTRA_API_BODY_LIMIT environment variable.
 * Default: 50MB (sufficient for long conversations with 100k+ tokens).
 */
export const PROXY_BODY_LIMIT = config.api.bodyLimit;
