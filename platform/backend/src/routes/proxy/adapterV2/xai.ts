/**
 * x.ai (Grok) LLM Provider Adapter
 * 
 * x.ai (Grok) is OpenAI compatible, so we reuse the OpenAI adapter implementation
 * with x.ai-specific configuration.
 * 
 * Base URL: https://api.x.ai/v1
 * API Documentation: https://docs.x.ai/docs/api-reference
 * 
 * Special features:
 * - Supports reasoning_effort parameter for controlling reasoning depth
 * - Vision processing supported
 * - Models: grok-4, grok-4-1-fast-reasoning, grok-4-1-fast-non-reasoning, grok-code-fast-1
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

type XaiRequest = OpenAi.Types.ChatCompletionsRequest;
type XaiResponse = OpenAi.Types.ChatCompletionsResponse;
type XaiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type XaiHeaders = OpenAi.Types.ChatCompletionsHeaders;
type XaiStreamChunk = OpenAi.Types.ChatCompletionChunk;

// =============================================================================
// X.AI REQUEST ADAPTER
// =============================================================================

class XaiRequestAdapter extends OpenAIRequestAdapter {
  readonly provider = "xai" as const;
}

// =============================================================================
// X.AI RESPONSE ADAPTER
// =============================================================================

class XaiResponseAdapter extends OpenAIResponseAdapter {
  readonly provider = "xai" as const;
}

// =============================================================================
// X.AI STREAM ADAPTER
// =============================================================================

class XaiStreamAdapter extends OpenAIStreamAdapter {
  readonly provider = "xai" as const;
}

// =============================================================================
// X.AI ADAPTER FACTORY
// =============================================================================

export const xaiAdapterFactory: LLMProvider<
  XaiRequest,
  XaiResponse,
  XaiMessages,
  XaiStreamChunk,
  XaiHeaders
> = {
  provider: "xai",
  interactionType: "xai:chatCompletions",

  createRequestAdapter(
    request: XaiRequest,
  ): LLMRequestAdapter<XaiRequest, XaiMessages> {
    return new XaiRequestAdapter(request);
  },

  createResponseAdapter(
    response: XaiResponse,
  ): LLMResponseAdapter<XaiResponse> {
    return new XaiResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<XaiStreamChunk, XaiResponse> {
    return new XaiStreamAdapter();
  },

  extractApiKey(headers: XaiHeaders): string | undefined {
    // Return the authorization header as-is (legacy behavior)
    // x.ai API uses Bearer authentication like OpenAI
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.xai?.baseUrl;
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
          "xai",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? "https://api.x.ai/v1",
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: XaiRequest,
  ): Promise<XaiResponse> {
    const xaiClient = client as OpenAIProvider;
    const xaiRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return xaiClient.chat.completions.create(
      xaiRequest,
    ) as Promise<XaiResponse>;
  },

  async executeStream(
    client: unknown,
    request: XaiRequest,
  ): Promise<AsyncIterable<XaiStreamChunk>> {
    const xaiClient = client as OpenAIProvider;
    const xaiRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await xaiClient.chat.completions.create(xaiRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as XaiStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // x.ai uses OpenAI-compatible SDK, so error structure should be similar
    const xaiMessage = get(error, "error.message");
    if (typeof xaiMessage === "string") {
      return xaiMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};