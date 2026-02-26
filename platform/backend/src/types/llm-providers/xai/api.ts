/**
 * x.ai API schemas - OpenAI-compatible
 *
 * x.ai uses an OpenAI-compatible API at https://api.x.ai/v1
 * We reuse OpenAI schemas with passthrough for x.ai-specific fields
 * (e.g. reasoning_effort).
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

/** Request schema with passthrough for x.ai params (reasoning_effort, etc.). */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for x.ai-specific fields. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
