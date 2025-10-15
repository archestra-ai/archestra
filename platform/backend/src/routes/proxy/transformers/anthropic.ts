import { randomUUID } from "node:crypto";
import type { Anthropic, OpenAi } from "@/types";
import type { ProviderTransformer } from "./common";

/**
 * Converts between Anthropic's messages format and OpenAI's chatCompletions format
 */
export class AnthropicMessagesTransformer
  implements
    ProviderTransformer<
      Anthropic.Types.MessagesRequest,
      Anthropic.Types.MessagesResponse,
      Anthropic.Types.MessagesResponse
    >
{
  provider = "anthropic:messages" as const;

  // TODO: Implement
  requestToOpenAI(
    _request: Anthropic.Types.MessagesRequest,
  ): OpenAi.Types.ChatCompletionsRequest {
    return {
      model: "gemini-pro", // Default model, should be passed separately
      messages: [],
      tools: [],
      stream: false, // Will be determined by endpoint
      temperature: 0,
      max_tokens: 0,
      tool_choice: "none",
    };
  }

  requestFromOpenAI(
    _request: OpenAi.Types.ChatCompletionsRequest,
  ): Anthropic.Types.MessagesRequest {
    return {};
  }

  responseToOpenAI(
    response: Anthropic.Types.MessagesResponse,
  ): OpenAi.Types.ChatCompletionsResponse {
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      model: response.modelVersion,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      choices: [],
      usage: undefined,
      system_fingerprint: null,
    };
  }

  // TODO: Implement
  responseFromOpenAI(
    _response: OpenAi.Types.ChatCompletionsResponse,
  ): Anthropic.Types.MessagesResponse {
    return {};
  }

  chunkToOpenAI(
    chunk: Anthropic.Types.MessagesResponse,
  ): OpenAi.Types.ChatCompletionChunk {
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: chunk.modelVersion || "gemini-pro",
      choices: [],
    };
  }
}
