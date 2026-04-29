/**
 * Azure AI Foundry API schemas
 *
 * Azure AI Foundry provides an OpenAI-compatible API at your deployment endpoint.
 * Full tool calling support, streaming, and standard OpenAI message format.
 *
 * @see https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-reference
 */

import {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ChatCompletionResponseSchema as OpenAIChatCompletionResponseSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
} from "../openai/api";

export {
  ChatCompletionRequestSchema,
  ChatCompletionsHeadersSchema,
  ChatCompletionUsageSchema,
  FinishReasonSchema,
  ResponsesRequestSchema,
  ResponsesResponseSchema,
  ResponsesUsageSchema,
};

export const ChatCompletionResponseSchema =
  OpenAIChatCompletionResponseSchema.passthrough();
