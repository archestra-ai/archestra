import type { OpenAi, SupportedProviderDiscriminator } from "@/types";

/**
 * Provider transformer interface
 *
 * Transformers convert between provider-specific formats and OpenAI's "chat completions" format.
 * The OpenAI "chat completions" format is used as the internal "common" format for data operations
 * (ex. static policy evaluation, dual-llm analysis, etc.).
 */
export interface ProviderTransformer<Request, Chunk, Response> {
  provider: SupportedProviderDiscriminator;

  /**
   * Convert provider-specific request to OpenAI format
   */
  requestToOpenAI(request: Request): OpenAi.Types.ChatCompletionsRequest;

  /**
   * Convert OpenAI format request to provider-specific format
   */
  requestFromOpenAI(request: OpenAi.Types.ChatCompletionsRequest): Request;

  /**
   * Convert provider-specific response to OpenAI format
   */
  responseToOpenAI(response: Response): OpenAi.Types.ChatCompletionsResponse;

  /**
   * Convert OpenAI format response to provider-specific format
   */
  responseFromOpenAI(response: OpenAi.Types.ChatCompletionsResponse): Response;

  /**
   * Convert provider-specific streaming chunk to OpenAI format
   */
  chunkToOpenAI?(chunk: Chunk): OpenAi.Types.ChatCompletionChunk;
}
