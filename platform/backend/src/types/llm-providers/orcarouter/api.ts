/**
 * OrcaRouter API schemas - OpenAI-compatible
 *
 * OrcaRouter exposes an OpenAI-compatible API at https://api.orcarouter.ai/v1
 * for chat completions and embeddings. We reuse OpenAI schemas and use
 * .passthrough() on the request/response to allow OrcaRouter-specific fields
 * (e.g. model-routing metadata).
 *
 * @see https://www.orcarouter.ai
 */

import {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionRequestSchema as OpenAIChatCompletionRequestSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export headers and other schemas from OpenAI
export {
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/** Request schema with passthrough for OrcaRouter params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for OrcaRouter-specific fields. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
