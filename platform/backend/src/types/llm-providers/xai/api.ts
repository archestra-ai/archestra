/**
 * xAI (Grok) API schemas
 *
 * xAI uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * Note: xAI responses may include extra fields that are not in the standard
 * OpenAI schema. We use .passthrough() on the response schema to allow
 * these additional fields.
 *
 * @see https://docs.x.ai/docs/api-reference
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since xAI is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * xAI response schema with passthrough for extra fields.
 * xAI API may return additional fields that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
