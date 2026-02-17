/**
 * Perplexity API schemas
 *
 * Perplexity uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * @see https://docs.perplexity.ai/api-reference
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since Perplexity is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Perplexity response schema with passthrough for extra fields.
 * Perplexity API may return additional fields not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
