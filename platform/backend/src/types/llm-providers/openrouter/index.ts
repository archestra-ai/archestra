/**
 * OpenRouter LLM Provider Types - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://openrouter.ai/docs
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OpenRouterAPI from "./api";
import * as OpenRouterMessages from "./messages";
import * as OpenRouterTools from "./tools";

namespace OpenRouter {
  export const API = OpenRouterAPI;
  export const Messages = OpenRouterMessages;
  export const Tools = OpenRouterTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenRouterAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenRouterAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenRouterAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenRouterAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenRouterAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenRouterMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since OpenRouter is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default OpenRouter;
