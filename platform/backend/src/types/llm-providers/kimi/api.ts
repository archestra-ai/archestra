/**
 * Kimi (Moonshot AI) API schemas - OpenAI-compatible
 *
 * Kimi uses an OpenAI-compatible API. We reuse OpenAI schemas and use
 * .passthrough() on request/response to allow Kimi-specific fields.
 *
 * @see https://platform.moonshot.ai/docs/api/chat
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

/** Request schema with passthrough for Kimi params (top_p, stop, etc.). */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for Kimi-specific token details, etc. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
