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
  ResponsesRequestSchema,
  ResponsesResponseSchema,
} from "../openai/api";

// The Responses surface shares OpenAI's request and response schemas and the
// same bearer header as chat completions; the proxy serves it over xAI's chat
// completions.
export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ChatCompletionsHeadersSchema as ResponsesHeadersSchema,
};

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
