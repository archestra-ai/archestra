/**
 * MiniMax API schemas
 *
 * MiniMax uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * Note: MiniMax responses may include extra fields that are not in the standard
 * OpenAI schema. We use .passthrough() on the response schema to allow these
 * additional fields.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since MiniMax is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * MiniMax response schema with passthrough for extra fields.
 * MiniMax API may return additional fields that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
