/**
 * DeepSeek API Types
 *
 * DeepSeek uses an OpenAI-compatible API with some extensions for reasoning models.
 * @see https://api-docs.deepseek.com/
 */
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

    export type ChatCompletionChunk = {
      id: string;
      object: "chat.completion.chunk";
      created: number;
      model: string;
      choices: Array<{
        index: number;
        delta: {
          role?: "assistant";
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: "function";
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
        completion_tokens_details?: {
          reasoning_tokens?: number;
        };
      };
    };
  }
}

export default DeepSeek;
