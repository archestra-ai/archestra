import OpenAIProvider from "openai";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import type {
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

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiStreamChunk = OpenAi.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

class GroqRequestAdapter extends OpenAIRequestAdapter {
  readonly provider = "groq" as const;
}

class GroqResponseAdapter extends OpenAIResponseAdapter {
  readonly provider = "groq" as const;
}

class GroqStreamAdapter extends OpenAIStreamAdapter {
  readonly provider = "groq" as const;
}

export const groqAdapterFactory: LLMProvider<
  OpenAiRequest,
  OpenAiResponse,
  OpenAiMessages,
  OpenAiStreamChunk,
  OpenAiHeaders
> = {
  provider: "groq",
  interactionType: "groq:chatCompletions",

  createRequestAdapter(
    request: OpenAiRequest,
  ): LLMRequestAdapter<OpenAiRequest, OpenAiMessages> {
    return new GroqRequestAdapter(request);
  },

  createResponseAdapter(
    response: OpenAiResponse,
  ): LLMResponseAdapter<OpenAiResponse> {
    return new GroqResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<OpenAiStreamChunk, OpenAiResponse> {
    return new GroqStreamAdapter();
  },

  extractApiKey(headers: OpenAiHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.groq.baseUrl;
  },

  getSpanName(): string {
    return "groq.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? getObservableFetch("groq", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: OpenAiRequest,
  ): Promise<OpenAiResponse> {
    const groqClient = client as OpenAIProvider;
    return groqClient.chat.completions.create({
      ...request,
      stream: false,
    } as any) as Promise<OpenAiResponse>;
  },

  async executeStream(
    client: unknown,
    request: OpenAiRequest,
  ): Promise<AsyncIterable<OpenAiStreamChunk>> {
    const groqClient = client as OpenAIProvider;
    const stream = await groqClient.chat.completions.create({
      ...request,
      stream: true,
      // Groq might not support include_usage in the same way, but let's try
      stream_options: { include_usage: true },
    } as any);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as OpenAiStreamChunk;
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
