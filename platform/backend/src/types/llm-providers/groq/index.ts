/**
 * Groq LLM Provider Types
 * 
 * Groq provides an OpenAI-compatible API, so we reuse most of the OpenAI schemas.
 * See: https://console.groq.com/docs/api-reference
 */
import type GroqSDK from "groq-sdk";
import type { z } from "zod";
import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
import type * as GroqModels from "./models";
import * as GroqTools from "./tools";

namespace Groq {
  export const API = GroqAPI;
  export const Messages = GroqMessages;
  export const Tools = GroqTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof GroqAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof GroqAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof GroqAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof GroqAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof GroqAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof GroqMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      GroqSDK.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof GroqModels.ModelSchema>;
    export type GroqModel = z.infer<typeof GroqModels.GroqModelSchema>;
  }
}

export default Groq;
