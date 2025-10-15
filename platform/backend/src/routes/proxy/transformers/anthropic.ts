import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Anthropic } from "@/types";
import type {
  OpenAiChunk,
  OpenAiRequest,
  OpenAiResponse,
  ProviderTransformer,
} from "./common";

type MessagesRequest = z.infer<typeof Anthropic.API.MessagesRequestSchema>;
type MessagesResponse = z.infer<typeof Anthropic.API.MessagesResponseSchema>;

/**
 * Converts between Anthropic's messages format and OpenAI's chatCompletions format
 */
export class AnthropicMessagesTransformer
  implements
    ProviderTransformer<MessagesRequest, MessagesResponse, MessagesResponse>
{
  provider = "anthropic:messages" as const;

  // TODO: Implement
  requestToOpenAI(_request: MessagesRequest): OpenAiRequest {
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

  requestFromOpenAI(_request: OpenAiRequest): MessagesRequest {
    return {};
  }

  responseToOpenAI(response: MessagesResponse): OpenAiResponse {
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
  responseFromOpenAI(_response: OpenAiResponse): MessagesResponse {
    return {};
  }

  chunkToOpenAI(chunk: MessagesResponse): OpenAiChunk {
    return {
      id: `chatcmpl-${randomUUID().replace(/-/g, "").substring(0, 29)}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: chunk.modelVersion || "gemini-pro",
      choices: [],
    };
  }
}
