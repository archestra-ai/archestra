/**
 * OpenRouter API schemas
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
} from "../openai/api";

export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
