/**
 * Groq LLM Provider Types - OpenAI-compatible
 *
 * Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://console.groq.com/docs/api-reference
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
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

    // Use OpenAI's stream chunk type since Groq is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Groq;
