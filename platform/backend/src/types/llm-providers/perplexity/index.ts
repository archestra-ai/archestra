/**
 * Perplexity LLM Provider Types - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API at https://api.perplexity.com/openai/v1
 * We re-export OpenAI schemas with Perplexity-specific namespace for type safety.
 *
 * @see https://console.perplexity.com/docs/api-reference
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as PerplexityAPI from "./api";
import * as PerplexityMessages from "./messages";
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

    // Use OpenAI's stream chunk type since Perplexity is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Perplexity;
