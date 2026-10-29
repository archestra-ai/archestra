/**
 * Kimi Code API schemas - OpenAI-compatible
 *
 * Kimi Code uses an OpenAI-compatible API. We reuse OpenAI schemas and use
 * .passthrough() on request/response to allow Kimi Code-specific fields.
 *
 * @see https://www.kimi.com/code/docs/en/
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

/** Request schema with passthrough for Kimi Code params (top_p, stop, etc.). */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for Kimi Code-specific token details, etc. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
