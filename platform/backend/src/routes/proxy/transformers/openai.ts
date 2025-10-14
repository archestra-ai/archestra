import type OpenAI from "openai";
import type { ProviderTransformer } from "./common";

/**
 * OpenAI transformer implementation
 * Since OpenAI format is our internal format, this is a simple pass-through
 */
export class OpenAITransformer implements ProviderTransformer {
  provider = "openai" as const;

  requestToOpenAI = (
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): OpenAI.Chat.ChatCompletionCreateParams => request;

  requestFromOpenAI = (
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): OpenAI.Chat.ChatCompletionCreateParams => request;

  responseToOpenAI = (
    response: OpenAI.Chat.ChatCompletion,
  ): OpenAI.Chat.ChatCompletion => response;

  responseFromOpenAI = (
    response: OpenAI.Chat.ChatCompletion,
  ): OpenAI.Chat.ChatCompletion => response;

  chunkToOpenAI = (
    chunk: OpenAI.Chat.ChatCompletionChunk,
  ): OpenAI.Chat.ChatCompletionChunk => chunk;

  chunkFromOpenAI = (
    chunk: OpenAI.Chat.ChatCompletionChunk,
  ): OpenAI.Chat.ChatCompletionChunk => chunk;
}
