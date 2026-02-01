/**
 * MiniMax LLM Provider Types - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API at https://api.minimax.chat/v1
 * We re-export OpenAI schemas with MiniMax-specific namespace for type safety.
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
 */
import type OpenAIProvider from "openai";
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
    export type Message = z.infer<
      typeof MiniMaxMessages.MessageParamSchema
    >;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since MiniMax is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default MiniMax;
