import type OpenAI from "openai";
import type { ProviderTransformer } from "./common";

/**
 * OpenAI chatCompletions transformer implementation
 * Since OpenAI's chatCompletions format is our internal format, this is a simple pass-through
 */
export class OpenAIChatCompletionsTransformer
  implements
    ProviderTransformer<
      OpenAI.Chat.ChatCompletionCreateParams,
      OpenAI.Chat.ChatCompletionChunk,
      OpenAI.Chat.ChatCompletion
    >
{
  provider = "openai:chatCompletions" as const;

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
}
