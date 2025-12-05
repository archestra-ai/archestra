export const PROXY_API_PREFIX = "/v1";

/**
 * Body size limit for LLM proxy routes.
 * Default Fastify limit is 1MB, which is too small for long conversations
 * with large context windows (100k+ tokens).
 *
 * 50MB should be sufficient for most use cases.
 */
export const PROXY_BODY_LIMIT = 50 * 1024 * 1024; // 50MB
