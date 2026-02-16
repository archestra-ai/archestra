/**
 * Grok LLM provider type definitions.
 *
 * Grok provides an OpenAI-compatible API with ultra-fast inference.
 * Base URL: https://api.x.ai/v1
 */
import type { z } from "zod";
import * as GrokAPI from "./api";
import * as GrokMessages from "./messages";
import * as GrokTools from "./tools";

namespace Grok {
  export const API = GrokAPI;
  export const Messages = GrokMessages;
  export const Tools = GrokTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof GrokAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof GrokAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof GrokAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof GrokAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof GrokAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof GrokMessages.MessageParamSchema>;
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
      x_grok?: {
        id?: string;
      };
    };
  }
}

export default Grok;
