/**
 * OpenRouter LLM provider type definitions.
 *
 * OpenRouter provides an OpenAI-compatible API with ultra-fast inference.
 * Base URL: https://openrouter.ai/api/v1
 */
import type { z } from "zod";
import * as OpenRouterAPI from "./api";
import * as OpenRouterMessages from "./messages";
import * as OpenRouterTools from "./tools";

namespace OpenRouter {
  export const API = OpenRouterAPI;
  export const Messages = OpenRouterMessages;
  export const Tools = OpenRouterTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenRouterAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenRouterAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenRouterAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenRouterAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenRouterAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenRouterMessages.MessageParamSchema>;
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
      };
      x_openrouter?: {
        id?: string;
      };
    };
  }
}

export default OpenRouter;
