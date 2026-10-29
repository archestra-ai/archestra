/**
 * Kimi Code LLM Provider Types - OpenAI-compatible
 *
 * Kimi Code uses an OpenAI-compatible API. We re-export OpenAI schemas with
 * passthrough for Kimi Code-specific fields; stream chunk type uses OpenAI SDK.
 *
 * @see https://www.kimi.com/code/docs/en/
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as KimiCodeAPI from "./api";
import * as KimiCodeMessages from "./messages";
import * as KimiCodeTools from "./tools";

namespace KimiCode {
  export const API = KimiCodeAPI;
  export const Messages = KimiCodeMessages;
  export const Tools = KimiCodeTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof KimiCodeAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof KimiCodeAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof KimiCodeAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof KimiCodeAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof KimiCodeAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof KimiCodeMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default KimiCode;
