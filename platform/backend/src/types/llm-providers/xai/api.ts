/**
 * xAI API schemas
 *
 * xAI provides an OpenAI-compatible API at https://api.x.ai/v1
 * Full tool calling support, streaming, and standard OpenAI message format.
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

export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
};

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
