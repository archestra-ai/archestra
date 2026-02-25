/**
 * OpenRouter LLM Proxy Adapter - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
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
  OpenRouter,
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
// TYPE ALIASES (reuse OpenAI types since OpenRouter is OpenAI-compatible)
// =============================================================================

type OpenRouterRequest = OpenRouter.Types.ChatCompletionsRequest;
type OpenRouterResponse = OpenRouter.Types.ChatCompletionsResponse;
type OpenRouterMessages = OpenRouter.Types.ChatCompletionsRequest["messages"];
type OpenRouterHeaders = OpenRouter.Types.ChatCompletionsHeaders;
type OpenRouterStreamChunk = OpenRouter.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

class OpenRouterRequestAdapter
  implements LLMRequestAdapter<OpenRouterRequest, OpenRouterMessages>
{
  readonly provider = "openrouter" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: OpenRouterRequest) {
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
  convertToolResultContent(messages: OpenRouterMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

class OpenRouterResponseAdapter implements LLMResponseAdapter<OpenRouterResponse> {
  readonly provider = "openrouter" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: OpenRouterResponse) {
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

class OpenRouterStreamAdapter
  implements LLMStreamAdapter<OpenRouterStreamChunk, OpenRouterResponse>
{
  readonly provider = "openrouter" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: OpenRouterStreamChunk) {
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
    // OpenRouter requires auth.
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.openrouter.baseUrl;
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
      throw new Error("API key required for OpenRouter");
    }

    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "openrouter",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
      defaultHeaders: {
        ...options?.defaultHeaders,
        "HTTP-Referer": "https://archestra.ai", // OpenRouter recommendation
        "X-Title": "Archestra",
      },
    });
  },

  async execute(client: unknown, request: OpenRouterRequest): Promise<OpenRouterResponse> {
    const openrouterClient = client as OpenAIProvider;
    const openrouterRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await openrouterClient.chat.completions.create(
      openrouterRequest,
    )) as unknown as OpenRouterResponse;
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
