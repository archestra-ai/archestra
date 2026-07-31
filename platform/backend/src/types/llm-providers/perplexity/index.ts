/**
 * Perplexity LLM Provider Types - OpenAI-compatible
 *
 * Perplexity serves two surfaces off one key namespace at
 * https://api.perplexity.ai:
 * - Chat completions for the `sonar*` models — no external tool calling
 *   (see inferPerplexityCapabilities in services/model-sync.ts), plus
 *   search_results citations and Perplexity-specific usage metrics
 * - The Responses-shaped Agent API at `/v1` for the vendor-prefixed models,
 *   the surface that accepts tools
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 * @see https://docs.perplexity.ai/api-reference/agent-post
 */
import type OpenAIProvider from "openai";
import type {
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
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

    // The Agent API surface, typed off the OpenAI Responses SDK types it is
    // wire-compatible with.
    export type ResponsesHeaders = z.infer<
      typeof PerplexityAPI.ResponsesHeadersSchema
    >;
    export type ResponsesRequest = ResponseCreateParams & { model: string };
    export type ResponsesResponse = Response;
    export type ResponsesUsage = z.infer<
      typeof PerplexityAPI.ResponsesUsageSchema
    >;
    export type ResponseChunk = ResponseStreamEvent;
  }
}

export default Perplexity;
