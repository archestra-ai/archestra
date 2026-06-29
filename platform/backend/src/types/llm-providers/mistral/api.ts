/**
 * Mistral API schemas
 *
 * Mistral uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * Note: Mistral responses may include extra fields (e.g., "p" for streaming metadata)
 * that are not in the standard OpenAI schema. We use .passthrough() on the response
 * schema to allow these additional fields.
 *
 * @see https://docs.mistral.ai/api
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since Mistral is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * Mistral response schema with passthrough for extra fields.
 * Mistral API returns additional fields like "p" that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
