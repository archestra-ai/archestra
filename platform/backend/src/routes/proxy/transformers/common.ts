import type OpenAI from "openai";
import type { SupportedProviderDiscriminator } from "@/types";

/**
 * Provider transformer interface
 *
 * Transformers convert between provider-specific formats and OpenAI format.
 * OpenAI types are used as the internal "common" format for utilities.
 */
export interface ProviderTransformer {
  provider: SupportedProviderDiscriminator;

  /**
   * Convert provider-specific request to OpenAI format
   */
  requestToOpenAI(request: unknown): OpenAI.Chat.ChatCompletionCreateParams;

  /**
   * Convert OpenAI format request to provider-specific format
   */
  requestFromOpenAI(request: OpenAI.Chat.ChatCompletionCreateParams): unknown;

  /**
   * Convert provider-specific response to OpenAI format
   */
  responseToOpenAI(response: unknown): OpenAI.Chat.ChatCompletion;

  /**
   * Convert OpenAI format response to provider-specific format
   */
  responseFromOpenAI(response: OpenAI.Chat.ChatCompletion): unknown;

  /**
   * Convert provider-specific streaming chunk to OpenAI format
   */
  chunkToOpenAI?(chunk: unknown): OpenAI.Chat.ChatCompletionChunk;

  /**
   * Convert OpenAI format chunk to provider-specific format
   */
  chunkFromOpenAI?(chunk: OpenAI.Chat.ChatCompletionChunk): unknown;
}
