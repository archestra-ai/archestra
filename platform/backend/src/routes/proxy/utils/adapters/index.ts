/**
 * @deprecated LEGACY ADAPTERS - Used only by LLM Proxy v1 routes
 *
 * These adapters are used by legacy v1 route handlers:
 * - src/routes/proxy/anthropic.ts
 * - src/routes/proxy/openai.ts
 * - src/routes/proxy/gemini.ts
 *
 * The new unified LLM proxy handler (src/routes/proxy/llm-proxy-handler.ts)
 * is now the default and uses the new adapter system in:
 * - src/routes/proxy/adapterV2/
 *
 * This directory should be removed after full migration to v2 routes.
 *
 * Note: vLLM uses openai adapters since it's OpenAI-compatible
 */
export * as anthropic from "./anthropic";
export * as gemini from "./gemini";
export * as openai from "./openai";
// vLLM is OpenAI-compatible, so it uses the openai adapter
export * as vllm from "./openai";
