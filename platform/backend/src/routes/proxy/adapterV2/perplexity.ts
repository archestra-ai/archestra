import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import type {
  CreateClientOptions,
  Perplexity,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type PerplexityRequest = Perplexity.Types.ChatCompletionsRequest;
type PerplexityResponse = Perplexity.Types.ChatCompletionsResponse;
type PerplexityMessages = Perplexity.Types.ChatCompletionsRequest["messages"];
type PerplexityHeaders = Perplexity.Types.ChatCompletionsHeaders;
type PerplexityStreamChunk = any;

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const perplexityAdapterFactory: LLMProvider<
  PerplexityRequest,
  PerplexityResponse,
  PerplexityMessages,
  PerplexityStreamChunk,
  PerplexityHeaders
> = {
  provider: "perplexity",
  interactionType: "perplexity:chatCompletions",

  createRequestAdapter(
    request: PerplexityRequest,
  ): LLMRequestAdapter<PerplexityRequest, PerplexityMessages> {
    // @ts-ignore
    return new OpenAIRequestAdapter(request);
  },

  createResponseAdapter(
    response: PerplexityResponse,
  ): LLMResponseAdapter<PerplexityResponse> {
    // @ts-ignore
    return new OpenAIResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse> {
    // @ts-ignore
    return new OpenAIStreamAdapter();
  },

  extractApiKey(headers: PerplexityHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.perplexity?.baseUrl || "https://api.perplexity.ai";
  },

  getSpanName(): string {
    return "perplexity.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options?.agent
      ? getObservableFetch("perplexity", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl || "https://api.perplexity.ai",
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: PerplexityRequest,
  ): Promise<PerplexityResponse> {
    const perplexityClient = client as OpenAIProvider;
    const perplexityRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return perplexityClient.chat.completions.create(
      perplexityRequest,
    ) as Promise<PerplexityResponse>;
  },

  async executeStream(
    client: unknown,
    request: PerplexityRequest,
  ): Promise<AsyncIterable<PerplexityStreamChunk>> {
    const perplexityClient = client as OpenAIProvider;
    const perplexityRequest = {
      ...request,
      stream: true,
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await perplexityClient.chat.completions.create(perplexityRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as PerplexityStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return "Internal server error";
  },
};
