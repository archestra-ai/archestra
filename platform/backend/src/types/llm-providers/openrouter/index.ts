/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * OpenRouter exposes an OpenAI-compatible API, so we define our own zod schemas..
 */
import type { z } from "zod";
import * as OpenrouterAPI from "./api";
import * as OpenrouterMessages from "./messages";
import * as OpenrouterTools from "./tools";

namespace Openrouter {
  export const API = OpenrouterAPI;
  export const Messages = OpenrouterMessages;
  export const Tools = OpenrouterTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenrouterAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenrouterAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenrouterAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenrouterAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenrouterAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenrouterMessages.MessageParamSchema>;
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
      };
    };
  }
}

export default Openrouter;
