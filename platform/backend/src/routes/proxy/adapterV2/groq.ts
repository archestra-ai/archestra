import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import type {
  CreateClientOptions,
  Groq,
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

type GroqRequest = Groq.Types.ChatCompletionsRequest;
type GroqResponse = Groq.Types.ChatCompletionsResponse;
type GroqMessages = Groq.Types.ChatCompletionsRequest["messages"];
type GroqHeaders = Groq.Types.ChatCompletionsHeaders;
type GroqStreamChunk = any; // Groq uses OpenAI-compatible chunks

// =============================================================================
// ADAPTER FACTORY
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
    // @ts-ignore - Groq types are compatible enough with OpenAI for the adapter
    return new OpenAIRequestAdapter(request);
  },

  createResponseAdapter(
    response: GroqResponse,
  ): LLMResponseAdapter<GroqResponse> {
    // @ts-ignore
    return new OpenAIResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<GroqStreamChunk, GroqResponse> {
    // @ts-ignore
    return new OpenAIStreamAdapter();
  },

  extractApiKey(headers: GroqHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.groq?.baseUrl || "https://api.groq.com/openai/v1";
  },

  getSpanName(): string {
    return "groq.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    const customFetch = options?.agent
      ? getObservableFetch("groq", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl || "https://api.groq.com/openai/v1",
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
    if (error instanceof Error) {
      return error.message;
    }
    return "Internal server error";
  },
};
