/**
 * DeepSeek API schemas - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API. We reuse OpenAI schemas and use
 * .passthrough() on request/response to allow DeepSeek-specific fields
 * (e.g. reasoning_content, prompt_tokens_details, completion_tokens_details).
 *
 * @see https://api-docs.deepseek.com/api/create-chat-completion
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

/** Request schema with passthrough for DeepSeek params (top_p, stop, etc.). */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for reasoning_content, token details, etc. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
