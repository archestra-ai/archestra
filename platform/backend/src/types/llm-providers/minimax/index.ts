import type { z } from "zod";
import * as MiniMaxAPI from "./api";
import * as MiniMaxMessages from "./messages";
import * as MiniMaxTools from "./tools";

namespace MiniMax {
  export const API = MiniMaxAPI;
  export const Messages = MiniMaxMessages;
  export const Tools = MiniMaxTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof MiniMaxAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof MiniMaxAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof MiniMaxAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof MiniMaxAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof MiniMaxAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof MiniMaxMessages.MessageParamSchema>;
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
        finish_reason: MiniMax.Types.FinishReason | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
  }
}

export default MiniMax;