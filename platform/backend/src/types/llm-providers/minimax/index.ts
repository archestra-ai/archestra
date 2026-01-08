/**
 * MiniMax LLM Provider Types
 *
 * MiniMax API is OpenAI-compatible (and also supports Anthropic format).
 * The main differences are:
 * - Base URL: https://api.minimax.io/v1 (international) or https://api.minimaxi.com/v1 (China)
 * - Model names: MiniMax-M2.1, MiniMax-M2, MiniMax-01, etc.
 * - Additional feature: reasoning_split for thinking/reasoning content
 */
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
  }
}

export default MiniMax;
