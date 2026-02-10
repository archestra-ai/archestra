/**
 * XAI LLM Provider Types - OpenAI-compatible
 *
 * XAI uses an OpenAI-compatible API at https://api.xai.com/openai/v1
 * We re-export OpenAI schemas with XAI-specific namespace for type safety.
 *
 * @see https://console.xai.com/docs/api-reference
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as XAIAPI from "./api";
import * as XAIMessages from "./messages";
import * as XAITools from "./tools";

namespace XAI {
  export const API = XAIAPI;
  export const Messages = XAIMessages;
  export const Tools = XAITools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof XAIAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof XAIAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof XAIAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof XAIAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof XAIAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof XAIMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since XAI is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default XAI;
