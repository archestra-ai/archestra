/**
 * OpenRouter LLM Provider Types
 *
 * OpenRouter provides an OpenAI-compatible API, so we re-export the OpenAI types.
 * This allows us to reuse the OpenAI adapter logic while maintaining proper
 * type safety and provider identification.
 *
 * @see https://openrouter.ai/docs/quickstart
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OpenAiAPI from "../openai/api";
import * as OpenAiMessages from "../openai/messages";
import * as OpenAiTools from "../openai/tools";

namespace OpenRouter {
  // Re-export OpenAI schemas since OpenRouter is OpenAI-compatible
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

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default OpenRouter;
