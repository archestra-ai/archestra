/**
 * GitHub Copilot API schemas - OpenAI-compatible
 *
 * GitHub Copilot's chat completions API (https://api.githubcopilot.com) is
 * OpenAI-compatible. We reuse OpenAI schemas and use .passthrough() on
 * request/response to allow Copilot-specific fields.
 *
 * @see https://docs.github.com/en/copilot
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

/** Request schema with passthrough for Copilot-specific params. */
export const ChatCompletionRequestSchema =
  OpenAIChatCompletionRequestSchema.passthrough();

/** Response schema with passthrough for Copilot-specific fields. */
export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
