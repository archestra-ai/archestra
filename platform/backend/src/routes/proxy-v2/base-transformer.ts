/**
 * Base Provider Transformer
 *
 * Abstract base class for provider transformations.
 * Each provider should implement transformation functions to convert
 * between provider format and OpenAI format (internal canonical format).
 */

import type { FastifyReply } from "fastify";
import type { OpenAi } from "@/types/llm-providers";

export type OpenAIRequest = OpenAi.Types.ChatCompletionsRequest;
export type OpenAIResponse = OpenAi.Types.ChatCompletionsResponse;
export type OpenAIStreamChunk = OpenAi.Types.ChatCompletionChunk;

/**
 * Bidirectional transformer for streaming chunks.
 *
 * Handles both directions:
 * - decode: Native provider events → OpenAI format (inbound from SDK)
 * - encode: OpenAI format → Native SSE events (outbound to client)
 *
 * MUST be created per streaming session because it's stateful
 * (tracks tool indices, content block lifecycle, etc.)
 *
 * @typeParam TStreamEvent - The provider's streaming event format
 */
export interface StreamTransformer<TStreamEvent> {
  /**
   * Decode a native provider streaming event to OpenAI chunk format.
   *
   * @param event - Provider-specific streaming event
   * @returns OpenAI stream chunk, or null to skip this event (e.g., ping events)
   */
  decode(event: TStreamEvent): OpenAIStreamChunk | null;

  /**
   * Check if an OpenAI chunk contains tool calls.
   * Used for buffering tool call chunks for policy evaluation.
   *
   * @param chunk - OpenAI stream chunk
   * @returns true if chunk contains tool_calls delta
   */
  isToolChunk(chunk: OpenAIStreamChunk): boolean;

  /**
   * Encode an OpenAI chunk to native provider SSE format and write to response.
   *
   * @param reply - Fastify reply object
   * @param chunk - OpenAI stream chunk to encode and write
   */
  encode(reply: FastifyReply, chunk: OpenAIStreamChunk): void;
}

/**
 * Base class for provider transformations.
 *
 * @typeParam ProviderRequest - The provider's request format
 * @typeParam ProviderResponse - The provider's response format
 * @typeParam ProviderStreamEvent - The provider's streaming event format
 */
export abstract class BaseProviderTransformer<
  ProviderRequest,
  ProviderResponse,
  ProviderStreamEvent,
> {
  /** Provider identifier */
  abstract readonly provider: string;

  /**
   * Convert incoming provider request to OpenAI format for internal processing.
   * This allows all business logic (policies, TOON, metrics) to work on one format.
   *
   * @param request - Provider-specific request format
   * @returns OpenAI format request for internal processing
   */
  abstract convertRequestToOpenAI(request: ProviderRequest): OpenAIRequest;

  /**
   * Convert OpenAI format to provider API format for the actual API call.
   *
   * @param request - OpenAI format request
   * @returns Provider-specific request format for API call
   */
  abstract convertRequestFromOpenAI(request: OpenAIRequest): ProviderRequest;

  /**
   * Convert provider response to OpenAI format for internal processing.
   *
   * @param response - Provider-specific response
   * @returns OpenAI format response for internal processing
   */
  abstract convertResponseToOpenAI(response: ProviderResponse): OpenAIResponse;

  /**
   * Convert OpenAI format back to provider format for client response.
   *
   * @param response - OpenAI format response
   * @returns Provider-specific response format for client
   */
  abstract convertResponseFromOpenAI(
    response: OpenAIResponse,
  ): ProviderResponse;

  /**
   * Create a stateful stream transformer for a streaming session.
   * Each streaming session should create a new transformer instance
   * to maintain independent state.
   *
   * @returns A new stateful stream transformer
   */
  abstract createStreamTransformer(): StreamTransformer<ProviderStreamEvent>;
}
