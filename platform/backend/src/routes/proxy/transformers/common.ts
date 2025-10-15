import type OpenAI from "openai";
import type { z } from "zod";
import type { OpenAi, SupportedProviderDiscriminator } from "@/types";

export type OpenAiRequest = z.infer<
  typeof OpenAi.API.ChatCompletionRequestSchema
>;
export type OpenAiResponse = z.infer<
  typeof OpenAi.API.ChatCompletionResponseSchema
>;
export type OpenAiChunk = OpenAI.Chat.Completions.ChatCompletionChunk;
export type OpenAiMessage = z.infer<typeof OpenAi.Messages.MessageParamSchema>;
export type OpenAiRole = OpenAiMessage["role"];
export type OpenAiFinishReason = z.infer<typeof OpenAi.API.FinishReasonSchema>;

/**
 * Provider transformer interface
 *
 * Transformers convert between provider-specific formats and OpenAI format.
 * OpenAI types are used as the internal "common" format for utilities.
 */
export interface ProviderTransformer<Request, Chunk, Response> {
  provider: SupportedProviderDiscriminator;

  /**
   * Convert provider-specific request to OpenAI format
   */
  requestToOpenAI(request: Request): OpenAiRequest;

  /**
   * Convert OpenAI format request to provider-specific format
   */
  requestFromOpenAI(request: OpenAiRequest): Request;

  /**
   * Convert provider-specific response to OpenAI format
   */
  responseToOpenAI(response: Response): OpenAiResponse;

  /**
   * Convert OpenAI format response to provider-specific format
   */
  responseFromOpenAI(response: OpenAiResponse): Response;

  /**
   * Convert provider-specific streaming chunk to OpenAI format
   */
  chunkToOpenAI?(chunk: Chunk): OpenAiChunk;
}
