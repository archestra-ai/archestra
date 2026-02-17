/**
 * OpenRouter API schemas
 *
 * OpenRouter uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * Note: OpenRouter responses may include extra fields (e.g., provider-specific metadata)
 * that are not in the standard OpenAI schema. We use .passthrough() on the response
 * schema to allow these additional fields.
 *
 * @see https://openrouter.ai/docs
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since OpenRouter is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * OpenRouter response schema with passthrough for extra fields.
 * OpenRouter API returns additional fields that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
