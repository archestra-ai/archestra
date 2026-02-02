/**
 * Groq API Type Definitions
 *
 * Groq provides an OpenAI-compatible API at https://api.groq.com/openai/v1.
 * These type definitions reuse the OpenAI schemas since the API format is identical.
 *
 * @see https://console.groq.com/docs/api-reference
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";

// Reuse OpenAI schemas as Groq is OpenAI-compatible
import * as OpenAiAPI from "../openai/api";
import * as OpenAiMessages from "../openai/messages";
import * as OpenAiTools from "../openai/tools";

namespace Groq {
  // Re-export OpenAI schemas as Groq schemas
  export const API = OpenAiAPI;
  export const Messages = OpenAiMessages;
  export const Tools = OpenAiTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenAiAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenAiAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenAiAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenAiAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenAiAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenAiMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Groq uses OpenAI-compatible chunk type
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Groq;

