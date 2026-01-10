/**
 * MiniMax provider type definitions
 *
 * MiniMax uses an OpenAI-compatible API format.
 * Reference: https://platform.minimaxi.com/document/ChatCompletion%20v2
 */
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

    export type ChatCompletionChunk = z.infer<
      typeof MiniMaxAPI.ChatCompletionChunkSchema
    >;
    export type Model = z.infer<typeof MiniMaxModels.ModelSchema>;
  }
}

export default MiniMax;
