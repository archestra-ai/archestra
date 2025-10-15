import type {
  OpenAiChunk,
  OpenAiRequest,
  OpenAiResponse,
  ProviderTransformer,
} from "./common";

/**
 * OpenAI chatCompletions transformer implementation
 * Since OpenAI's chatCompletions format is our internal format, this is a simple pass-through
 */
export class OpenAIChatCompletionsTransformer
  implements ProviderTransformer<OpenAiRequest, OpenAiChunk, OpenAiResponse>
{
  provider = "openai:chatCompletions" as const;
  requestToOpenAI = (request: OpenAiRequest): OpenAiRequest => request;
  requestFromOpenAI = (request: OpenAiRequest): OpenAiRequest => request;
  responseToOpenAI = (response: OpenAiResponse): OpenAiResponse => response;
  responseFromOpenAI = (response: OpenAiResponse): OpenAiResponse => response;
  chunkToOpenAI = (chunk: OpenAiChunk): OpenAiChunk => chunk;
}
