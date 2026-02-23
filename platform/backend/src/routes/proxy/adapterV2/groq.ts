/**
 * Groq LLM Provider Adapter
 * 
 * Groq is OpenAI compatible, so we reuse the OpenAI adapter implementation
 * with Groq-specific configuration.
 * 
 * Base URL: https://api.groq.com/openai/v1
 * API Documentation: https://console.groq.com/docs/api-reference
 */

import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import logger from "@/logging";
import { metrics } from "@/observability";
import type {
  ChunkProcessingResult,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type GroqRequest = OpenAi.Types.ChatCompletionsRequest;
type GroqResponse = OpenAi.Types.ChatCompletionsResponse;
type GroqMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type GroqHeaders = OpenAi.Types.ChatCompletionsHeaders;
type GroqStreamChunk = OpenAi.Types.ChatCompletionChunk;

// =============================================================================
// GROQ REQUEST ADAPTER
// =============================================================================

class GroqRequestAdapter extends OpenAIRequestAdapter {
  readonly provider = "groq" as const;
}

// =============================================================================
// GROQ RESPONSE ADAPTER
// =============================================================================

class GroqResponseAdapter extends OpenAIResponseAdapter {
  readonly provider = "groq" as const;
}

// =============================================================================
// GROQ STREAM ADAPTER
// =============================================================================

class GroqStreamAdapter extends OpenAIStreamAdapter {
  readonly provider = "groq" as const;
}

// =============================================================================
// GROQ ADAPTER FACTORY
// =============================================================================

export const groqAdapterFactory: LLMProvider<
  GroqRequest,
  GroqResponse,
  GroqMessages,
  GroqStreamChunk,
  GroqHeaders
> = {
  provider: "groq",
  interactionType: "groq:chatCompletions",

  createRequestAdapter(
    request: GroqRequest,
  ): LLMRequestAdapter<GroqRequest, GroqMessages> {
    return new GroqRequestAdapter(request);
  },

  createResponseAdapter(
    response: GroqResponse,
  ): LLMResponseAdapter<GroqResponse> {
    return new GroqResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<GroqStreamChunk, GroqResponse> {
    return new GroqStreamAdapter();
  },

  extractApiKey(headers: GroqHeaders): string | undefined {
    // Return the authorization header as-is (legacy behavior)
    // OpenAI SDK handles both "Bearer gsk_xxx" and "gsk_xxx" formats
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.groq?.baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    // Use observable fetch for request duration metrics if agent is provided
    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "groq",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? "https://api.groq.com/openai/v1",
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: GroqRequest,
  ): Promise<GroqResponse> {
    const groqClient = client as OpenAIProvider;
    const groqRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return groqClient.chat.completions.create(
      groqRequest,
    ) as Promise<GroqResponse>;
  },

  async executeStream(
    client: unknown,
    request: GroqRequest,
  ): Promise<AsyncIterable<GroqStreamChunk>> {
    const groqClient = client as OpenAIProvider;
    const groqRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await groqClient.chat.completions.create(groqRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as GroqStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // Groq uses OpenAI SDK, so error structure should be similar
    const groqMessage = get(error, "error.message");
    if (typeof groqMessage === "string") {
      return groqMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};