/**
 * x.ai (Grok) API schemas - OpenAI-compatible
 *
 * x.ai uses an OpenAI-compatible API. We reuse OpenAI schemas and use
 * .passthrough() on request/response to allow x.ai-specific fields.
 *
 * @see https://docs.x.ai/docs/api-reference
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

/** Request schema with passthrough for x.ai params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for x.ai-specific fields. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
