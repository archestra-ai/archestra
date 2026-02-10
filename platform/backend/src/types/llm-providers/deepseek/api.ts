/**
 * DeepSeek API schemas
 *
 * DeepSeek uses an OpenAI-compatible API, so we reuse OpenAI schemas directly.
 * This ensures type compatibility when delegating to OpenAI adapters.
 *
 * Note: DeepSeek responses may include extra fields (e.g., reasoning_content)
 * that are not in the standard OpenAI schema. We use .passthrough() on the response
 * schema to allow these additional fields.
 *
 * @see https://api-docs.deepseek.com
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

// Re-export request and other schemas from OpenAI since DeepSeek is fully compatible
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

/**
 * DeepSeek response schema with passthrough for extra fields.
 * DeepSeek API returns additional fields like "reasoning_content" that are not in the standard OpenAI schema.
 */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
