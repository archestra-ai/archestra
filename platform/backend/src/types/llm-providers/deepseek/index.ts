/**
 * DeepSeek Type Definitions
 *
 * DeepSeek is an OpenAI-compatible inference server.
 * See: https://api-docs.deepseek.com/
 *
 * NOTE: DeepSeek types are very similar to OpenAI since DeepSeek implements the OpenAI API.
 * The main differences are:
 * - DeepSeek requires API keys
 * - DeepSeek may have model-specific fields like "reasoning_content"
 * - Models: deepseek-chat, deepseek-reasoner
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as DeepseekAPI from "./api";
import * as DeepseekMessages from "./messages";
import type * as DeepseekModels from "./models";
import * as DeepseekTools from "./tools";

namespace Deepseek {
  export const API = DeepseekAPI;
  export const Messages = DeepseekMessages;
  export const Tools = DeepseekTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof DeepseekAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof DeepseekAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof DeepseekAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof DeepseekAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof DeepseekAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof DeepseekMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // DeepSeek uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof DeepseekModels.ModelSchema>;
  }
}

export default Deepseek;
