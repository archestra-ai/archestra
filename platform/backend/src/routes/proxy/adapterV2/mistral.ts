/**
 * Mistral AI Adapter for LLM Proxy
 *
 * Mistral uses an OpenAI-compatible API, so we reuse the OpenAI adapter implementations.
 * The base URL is https://api.mistral.ai/v1 by default.
 *
 * @see https://docs.mistral.ai/api/
 */
import {
  openaiAdapterFactory,
  type OpenAIRequestAdapter,
  type OpenAIResponseAdapter,
  type OpenAIStreamAdapter,
} from "./openai";

/**
 * Mistral uses OpenAI-compatible API format, so we reuse the OpenAI adapters.
 * The only difference is the base URL configuration (handled in config.ts).
 */
export type MistralRequestAdapter = OpenAIRequestAdapter;
export type MistralResponseAdapter = OpenAIResponseAdapter;
export type MistralStreamAdapter = OpenAIStreamAdapter;

/**
 * Factory function to create Mistral adapters.
 * Since Mistral is OpenAI-compatible, we reuse the OpenAI adapter factory.
 */
export const mistralAdapterFactory = openaiAdapterFactory;
