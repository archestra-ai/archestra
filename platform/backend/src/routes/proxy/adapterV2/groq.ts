/**
 * Groq LLM Proxy Adapter - OpenAI-compatible
 *
 * Groq uses an OpenAI-compatible API at https://api.groq.com/openai/v1
 * This adapter delegates request/response/stream parsing to the OpenAI adapters
 * and only overrides provider-specific configuration (baseUrl, api key behavior).
 */
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  CreateClientOptions,
  Groq,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since Groq is OpenAI-compatible)
// =============================================================================

type GroqRequest = Groq.Types.ChatCompletionsRequest;
type GroqResponse = Groq.Types.ChatCompletionsResponse;
type GroqMessages = Groq.Types.ChatCompletionsRequest["messages"];
type GroqHeaders = Groq.Types.ChatCompletionsHeaders;
type GroqStreamChunk = Groq.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

class GroqRequestAdapter
  implements LLMRequestAdapter<GroqRequest, GroqMessages>
{
  readonly provider = "groq" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: GroqRequest) {
    this.delegate = new OpenAIRequestAdapter(request);
  }

  getModel() {
    return this.delegate.getModel();
  }
  isStreaming() {
    return this.delegate.isStreaming();
  }
  getMessages() {
    return this.delegate.getMessages();
  }
  getToolResults() {
    return this.delegate.getToolResults();
  }
  getTools() {
    return this.delegate.getTools();
  }
  hasTools() {
    return this.delegate.hasTools();
  }
  getProviderMessages() {
    return this.delegate.getProviderMessages();
  }
  getOriginalRequest() {
    return this.delegate.getOriginalRequest();
  }
  setModel(model: string) {
    return this.delegate.setModel(model);
  }
  updateToolResult(toolCallId: string, newContent: string) {
    return this.delegate.updateToolResult(toolCallId, newContent);
  }
  applyToolResultUpdates(updates: Record<string, string>) {
    return this.delegate.applyToolResultUpdates(updates);
  }
  applyToonCompression(model: string) {
    return this.delegate.applyToonCompression(model);
  }
  convertToolResultContent(messages: GroqMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

class GroqResponseAdapter implements LLMResponseAdapter<GroqResponse> {
  readonly provider = "groq" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: GroqResponse) {
    this.delegate = new OpenAIResponseAdapter(response);
  }

  getId() {
    return this.delegate.getId();
  }
  getModel() {
    return this.delegate.getModel();
  }
  getText() {
    return this.delegate.getText();
  }
  getToolCalls() {
    return this.delegate.getToolCalls();
  }
  hasToolCalls() {
    return this.delegate.hasToolCalls();
  }
  getUsage() {
    return this.delegate.getUsage();
  }
  getOriginalResponse() {
    return this.delegate.getOriginalResponse();
  }
  getFinishReasons() {
    return this.delegate.getFinishReasons();
  }
  toRefusalResponse(refusalMessage: string, contentMessage: string) {
    return this.delegate.toRefusalResponse(refusalMessage, contentMessage);
  }
}

class GroqStreamAdapter
  implements LLMStreamAdapter<GroqStreamChunk, GroqResponse>
{
  readonly provider = "groq" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: GroqStreamChunk) {
    return this.delegate.processChunk(chunk);
  }
  getSSEHeaders() {
    return this.delegate.getSSEHeaders();
  }
  formatTextDeltaSSE(text: string) {
    return this.delegate.formatTextDeltaSSE(text);
  }
  getRawToolCallEvents() {
    return this.delegate.getRawToolCallEvents();
  }
  formatCompleteTextSSE(text: string) {
    return this.delegate.formatCompleteTextSSE(text);
  }
  formatEndSSE() {
    return this.delegate.formatEndSSE();
  }
  toProviderResponse() {
    return this.delegate.toProviderResponse();
  }
}

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
    // Groq requires auth (unlike many self-hosted OpenAI-compatible providers).
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.groq.baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    if (!apiKey) {
      throw new Error("API key required for Groq");
    }

    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "groq",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
      defaultHeaders: options?.defaultHeaders,
    });
  },

  async execute(client: unknown, request: GroqRequest): Promise<GroqResponse> {
    const groqClient = client as OpenAIProvider;
    const groqRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await groqClient.chat.completions.create(
      groqRequest,
    )) as unknown as GroqResponse;
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
