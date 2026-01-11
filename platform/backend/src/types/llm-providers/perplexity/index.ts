/**
 * Perplexity Type Definitions
 *
 * Perplexity AI is an OpenAI-compatible API at https://api.perplexity.ai
 * See: https://docs.perplexity.ai/api-reference/chat-completions-post
 *
 * Available models:
 * - sonar: Standard search model
 * - sonar-pro: Advanced search model with more capabilities
 * - sonar-reasoning: Search model with reasoning capabilities
 * - sonar-reasoning-pro: Advanced reasoning model
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as PerplexityAPI from "./api";
import * as PerplexityMessages from "./messages";
import type * as PerplexityModels from "./models";
import * as PerplexityTools from "./tools";

namespace Perplexity {
  export const API = PerplexityAPI;
  export const Messages = PerplexityMessages;
  export const Tools = PerplexityTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof PerplexityAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof PerplexityAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof PerplexityAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof PerplexityAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof PerplexityAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof PerplexityMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Perplexity uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof PerplexityModels.ModelSchema>;
  }
}

export default Perplexity;
