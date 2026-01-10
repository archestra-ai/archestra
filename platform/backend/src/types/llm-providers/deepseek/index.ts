/**
 * DeepSeek Type Definitions
 *
 * DeepSeek is an OpenAI-compatible inference API.
 * See: https://api-docs.deepseek.com/
 *
 * NOTE: DeepSeek types are similar to OpenAI since DeepSeek implements the OpenAI API.
 * The main differences are:
 * - DeepSeek requires API keys
 * - DeepSeek-R1 models may have a reasoning_content field
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as DeepSeekAPI from "./api";
import * as DeepSeekMessages from "./messages";
import type * as DeepSeekModels from "./models";
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

    // DeepSeek uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof DeepSeekModels.ModelSchema>;
  }
}

export default DeepSeek;
