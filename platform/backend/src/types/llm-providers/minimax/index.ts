/**
 * MiniMax Type Definitions
 *
 * MiniMax is an OpenAI-compatible API provider.
 * See: https://platform.minimax.io/docs/api-reference/text-openai-api
 *
 * NOTE: MiniMax types are very similar to OpenAI since MiniMax implements the OpenAI API.
 * The main differences are:
 * - MiniMax has its own models (MiniMax-M2, MiniMax-M2.1)
 * - MiniMax may have additional features specific to their platform
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MiniMaxAPI from "./api";
import * as MiniMaxMessages from "./messages";
import type * as MiniMaxModels from "./models";
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

    // MiniMax uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof MiniMaxModels.ModelSchema>;
  }
}

export default MiniMax;
