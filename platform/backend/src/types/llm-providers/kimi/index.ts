/**
 * Kimi (Moonshot AI) LLM Provider Types - OpenAI-compatible
 *
 * Kimi uses an OpenAI-compatible API. We re-export OpenAI schemas with
 * passthrough for Kimi-specific fields; stream chunk type uses OpenAI SDK.
 *
 * @see https://platform.moonshot.ai/docs/api/chat
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as KimiAPI from "./api";
import * as KimiMessages from "./messages";
import * as KimiTools from "./tools";

namespace Kimi {
  export const API = KimiAPI;
  export const Messages = KimiMessages;
  export const Tools = KimiTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof KimiAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof KimiAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof KimiAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof KimiAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof KimiAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof KimiMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Kimi;
