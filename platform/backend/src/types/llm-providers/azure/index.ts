/**
 * Azure AI Foundry LLM Provider Types - OpenAI-compatible
 *
 * Azure AI Foundry provides an OpenAI-compatible API at your deployment endpoint.
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://learn.microsoft.com/en-us/azure/ai-foundry/openai/api-reference
 */
import type OpenAIProvider from "openai";
import type {
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { z } from "zod";
import * as AzureAPI from "./api";
import * as AzureMessages from "./messages";
import * as AzureTools from "./tools";

namespace Azure {
  export const API = AzureAPI;
  export const Messages = AzureMessages;
  export const Tools = AzureTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof AzureAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof AzureAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof AzureAPI.ChatCompletionResponseSchema
    >;
    export type ResponsesRequest = ResponseCreateParams & { model: string };
    export type ResponsesResponse = Response;
    export type Usage = z.infer<typeof AzureAPI.ChatCompletionUsageSchema>;
    export type ResponsesUsage = z.infer<typeof AzureAPI.ResponsesUsageSchema>;

    export type FinishReason = z.infer<typeof AzureAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof AzureMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type ResponseObject = Response;
    export type ResponseChunk = ResponseStreamEvent;
  }
}

export default Azure;
