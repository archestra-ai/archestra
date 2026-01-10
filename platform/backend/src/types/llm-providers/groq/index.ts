/**
 * Groq Type Definitions
 *
 * Groq provides an OpenAI-compatible inference API with ultra-fast inference.
 * See: https://console.groq.com/docs/api-reference
 *
 * NOTE: Groq types are very similar to OpenAI since Groq implements the OpenAI API.
 * The main differences are:
 * - Groq has additional timing fields in usage (completion_time, prompt_time, etc.)
 * - Groq has specific model IDs (llama-3.3-70b-versatile, mixtral-8x7b-32768, etc.)
 * - Groq may return x_groq field in response
 */
import type OpenAIProvider from "openai";
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

    // Groq uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof GroqModels.ModelSchema>;
  }
}

export default Groq;
