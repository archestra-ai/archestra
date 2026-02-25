/**
 * MiniMax LLM Provider Types - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API with additional reasoning_details
 * support for thinking content.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MinimaxAPI from "./api";
import * as MinimaxMessages from "./messages";
import * as MinimaxTools from "./tools";

namespace Minimax {
  export const API = MinimaxAPI;
  export const Messages = MinimaxMessages;
  export const Tools = MinimaxTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof MinimaxAPI.ChatCompletionHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof MinimaxAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof MinimaxAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof MinimaxAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof MinimaxAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof MinimaxMessages.MessageParamSchema>;
    export type Role = Message["role"];

    /**
     * Streaming response chunk - extends OpenAI's type with reasoning_details
     * for thinking content (when reasoning_split=True is used in request)
     */
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk & {
        choices: Array<{
          delta: {
            reasoning_details?: Array<{ text?: string }>;
          };
        }>;
      };
  }
}

export default Minimax;
