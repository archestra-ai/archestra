/**
 * DeepSeek LLM Provider Types - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API at https://api.deepseek.com/openai/v1
 * We re-export OpenAI schemas with DeepSeek-specific namespace for type safety.
 *
 * @see https://console.deepseek.com/docs/api-reference
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as DeepSeekAPI from "./api";
import * as DeepSeekMessages from "./messages";
import * as DeepSeekTools from "./tools";

namespace DeepSeek {
  export const API = DeepSeekAPI;
  export const Messages = DeepSeekMessages;
  export const Tools = DeepSeekTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof DeepSeekAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof DeepSeekAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof DeepSeekAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof DeepSeekAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof DeepSeekAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof DeepSeekMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since DeepSeek is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default DeepSeek;
