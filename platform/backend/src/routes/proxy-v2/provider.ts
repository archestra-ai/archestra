/**
 * Provider Interface for LLM Proxy V2
 *
 * Defines the core interfaces for provider implementations.
 * Each provider (Anthropic, OpenAI, Gemini) implements this interface
 * to handle request/response transformation and API calls.
 */

import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@shared";
import type { FastifyReply } from "fastify";
import type { Agent } from "@/types";
import type { BaseProviderTransformer } from "./base-transformer";

/**
 * Context passed to provider methods for each request.
 * Contains authentication and observability info.
 */
export interface ProxyContext {
  /** API key from request headers */
  apiKey: string;
  /** Resolved agent/profile for this request */
  agent: Agent;
  /** External agent ID for metrics (optional) */
  externalAgentId?: string;
}

/**
 * Provider interface for LLM API interactions.
 *
 * Providers are stateless singletons. SDK clients are created
 * inside call()/stream() as needed using the ProxyContext.
 *
 * @typeParam TRequest - Provider's request format
 * @typeParam TResponse - Provider's response format
 * @typeParam TStreamEvent - Provider's streaming event format
 */
export interface Provider<TRequest, TResponse, TStreamEvent> {
  /** Provider identifier: "openai" | "anthropic" | "gemini" */
  readonly name: SupportedProvider;

  /** Interaction type for recording: "openai:chatCompletions" | "anthropic:messages" | "gemini:generateContent" */
  readonly interactionType: SupportedProviderDiscriminator;

  /** Transformer for format conversions */
  readonly transformer: BaseProviderTransformer<
    TRequest,
    TResponse,
    TStreamEvent
  >;

  /**
   * Make a non-streaming API call.
   *
   * @param request - Provider-specific request
   * @param context - Authentication and observability context
   * @returns Provider-specific response
   */
  call(request: TRequest, context: ProxyContext): Promise<TResponse>;

  /**
   * Make a streaming API call.
   *
   * @param request - Provider-specific request
   * @param context - Authentication and observability context
   * @returns Stream result with events iterator and accumulated response getter
   */
  stream(
    request: TRequest,
    context: ProxyContext,
  ): Promise<StreamResult<TStreamEvent, TResponse>>;

  /**
   * Set up streaming response headers on the reply.
   *
   * @param reply - Fastify reply object
   */
  setupStreamingHeaders(reply: FastifyReply): void;

  /**
   * Format an error for non-streaming response.
   * Each provider has its own error response structure.
   *
   * @param error - The error that occurred
   * @returns Provider-specific error response body
   */
  formatErrorResponse(error: unknown): unknown;

  /**
   * Write an error event in streaming format.
   * Called when an error occurs during streaming.
   *
   * @param reply - Fastify reply object
   * @param error - The error that occurred
   */
  writeStreamError(reply: FastifyReply, error: unknown): void;

  /**
   * Extract HTTP status code from an error.
   * Returns 500 if status cannot be determined.
   *
   * @param error - The error that occurred
   * @returns HTTP status code
   */
  getErrorStatusCode(error: unknown): number;
}

/**
 * Result from a streaming API call.
 * Provides access to events and accumulated response.
 */
export interface StreamResult<TStreamEvent, TResponse> {
  /** Async iterator of streaming events */
  events: AsyncIterable<TStreamEvent>;
  /** Get the final accumulated response after streaming completes */
  getAccumulatedResponse(): Promise<TResponse>;
}
