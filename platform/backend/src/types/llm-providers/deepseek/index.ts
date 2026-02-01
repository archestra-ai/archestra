/**
 * DeepSeek LLM Provider Types - OpenAI-compatible
 *
 * DeepSeek uses an OpenAI-compatible API at https://api.deepseek.com/v1
 * We re-export OpenAI schemas with DeepSeek-specific namespace for type safety.
 *
 * @see https://api-docs.deepseek.com/
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as DeepseekAPI from "./api";
import * as DeepseekMessages from "./messages";
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
    export type Message = z.infer<
      typeof DeepseekMessages.MessageParamSchema
    >;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since DeepSeek is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Deepseek;
