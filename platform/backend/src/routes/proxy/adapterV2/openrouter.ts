/**
 * OpenRouter LLM Provider Adapter
 * 
 * OpenRouter is OpenAI compatible, so we reuse the OpenAI adapter implementation
 * with OpenRouter-specific configuration.
 * 
 * Base URL: https://openrouter.ai/api/v1
 * API Documentation: https://openrouter.ai/docs
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

type OpenRouterRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenRouterResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenRouterMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenRouterHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenRouterStreamChunk = OpenAi.Types.ChatCompletionChunk;

// =============================================================================
// OPENROUTER REQUEST ADAPTER
// =============================================================================

class OpenRouterRequestAdapter extends OpenAIRequestAdapter {
  readonly provider = "openrouter" as const;
}

// =============================================================================
// OPENROUTER RESPONSE ADAPTER
// =============================================================================

class OpenRouterResponseAdapter extends OpenAIResponseAdapter {
  readonly provider = "openrouter" as const;
}

// =============================================================================
// OPENROUTER STREAM ADAPTER
// =============================================================================

class OpenRouterStreamAdapter extends OpenAIStreamAdapter {
  readonly provider = "openrouter" as const;
}

// =============================================================================
// OPENROUTER ADAPTER FACTORY
// =============================================================================

export const openrouterAdapterFactory: LLMProvider<
  OpenRouterRequest,
  OpenRouterResponse,
  OpenRouterMessages,
  OpenRouterStreamChunk,
  OpenRouterHeaders
> = {
  provider: "openrouter",
  interactionType: "openrouter:chatCompletions",

  createRequestAdapter(
    request: OpenRouterRequest,
  ): LLMRequestAdapter<OpenRouterRequest, OpenRouterMessages> {
    return new OpenRouterRequestAdapter(request);
  },

  createResponseAdapter(
    response: OpenRouterResponse,
  ): LLMResponseAdapter<OpenRouterResponse> {
    return new OpenRouterResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<OpenRouterStreamChunk, OpenRouterResponse> {
    return new OpenRouterStreamAdapter();
  },

  extractApiKey(headers: OpenRouterHeaders): string | undefined {
    // Return the authorization header as-is (legacy behavior)
    // OpenAI SDK handles both "Bearer sk-or-xxx" and "sk-or-xxx" formats
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.openrouter?.baseUrl;
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
          "openrouter",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? "https://openrouter.ai/api/v1",
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: OpenRouterRequest,
  ): Promise<OpenRouterResponse> {
    const openrouterClient = client as OpenAIProvider;
    const openrouterRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return openrouterClient.chat.completions.create(
      openrouterRequest,
    ) as Promise<OpenRouterResponse>;
  },

  async executeStream(
    client: unknown,
    request: OpenRouterRequest,
  ): Promise<AsyncIterable<OpenRouterStreamChunk>> {
    const openrouterClient = client as OpenAIProvider;
    const openrouterRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await openrouterClient.chat.completions.create(openrouterRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as OpenRouterStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // OpenRouter uses OpenAI SDK, so error structure should be similar
    const openrouterMessage = get(error, "error.message");
    if (typeof openrouterMessage === "string") {
      return openrouterMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};