/**
 * OpenRouter LLM Proxy Adapter - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * This adapter reuses OpenAI's adapter factory with OpenRouter-specific configuration.
 *
 * Since OpenRouter is 100% OpenAI-compatible, we delegate all adapter logic to OpenAI
 * and only override the provider-specific configuration (baseUrl, provider name, etc.).
 *
 * @see https://openrouter.ai/docs/quickstart
 */
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import type {
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenRouter,
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

/**
 * OpenRouter request adapter - wraps OpenAI adapter with OpenRouter provider name.
 * Uses composition to delegate all logic to OpenAI since APIs are identical.
 */
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

/**
 * OpenRouter response adapter - wraps OpenAI adapter with OpenRouter provider name.
 */
class OpenRouterResponseAdapter
  implements LLMResponseAdapter<OpenRouterResponse>
{
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
  toRefusalResponse(refusalMessage: string, contentMessage: string) {
    return this.delegate.toRefusalResponse(refusalMessage, contentMessage);
  }
}

/**
 * OpenRouter stream adapter - wraps OpenAI adapter with OpenRouter provider name.
 */
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

  createStreamAdapter(): LLMStreamAdapter<
    OpenRouterStreamChunk,
    OpenRouterResponse
  > {
    return new OpenRouterStreamAdapter();
  },

  extractApiKey(headers: OpenRouterHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.openrouter.baseUrl;
  },

  getSpanName(): string {
    return "openrouter.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? getObservableFetch("openrouter", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? config.llm.openrouter.baseUrl,
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
    // Cast through unknown because OpenRouterResponse uses .passthrough() which adds index signature
    return openrouterClient.chat.completions.create(
      openrouterRequest,
    ) as unknown as Promise<OpenRouterResponse>;
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
    const stream =
      await openrouterClient.chat.completions.create(openrouterRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as OpenRouterStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    const openaiMessage = get(error, "error.message");
    if (typeof openaiMessage === "string") {
      return openaiMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
