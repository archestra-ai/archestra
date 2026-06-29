/**
 * Perplexity LLM Provider Types - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API at https://api.perplexity.ai
 *
 * Key differences from OpenAI:
 * - No external tool calling support
 * - Returns search_results field with web search citations
 * - Has Perplexity-specific usage metrics
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
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
