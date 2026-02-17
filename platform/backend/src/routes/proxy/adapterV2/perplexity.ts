/**
 * Perplexity LLM Proxy Adapter - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API at https://api.perplexity.ai
 * This adapter reuses OpenAI's adapter factory with Perplexity-specific configuration.
 *
 * Since Perplexity is 100% OpenAI-compatible, we delegate all adapter logic to OpenAI
 * and only override the provider-specific configuration (baseUrl, provider name, etc.).
 *
 * @see https://docs.perplexity.ai/api-reference
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
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  Perplexity,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since Perplexity is OpenAI-compatible)
// =============================================================================

type PerplexityRequest = Perplexity.Types.ChatCompletionsRequest;
type PerplexityResponse = Perplexity.Types.ChatCompletionsResponse;
type PerplexityMessages = Perplexity.Types.ChatCompletionsRequest["messages"];
type PerplexityHeaders = Perplexity.Types.ChatCompletionsHeaders;
type PerplexityStreamChunk = Perplexity.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

/**
 * Perplexity request adapter - wraps OpenAI adapter with Perplexity provider name.
 * Uses composition to delegate all logic to OpenAI since APIs are identical.
 */
class PerplexityRequestAdapter
  implements LLMRequestAdapter<PerplexityRequest, PerplexityMessages>
{
  readonly provider = "perplexity" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: PerplexityRequest) {
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
  convertToolResultContent(messages: PerplexityMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

/**
 * Perplexity response adapter - wraps OpenAI adapter with Perplexity provider name.
 */
class PerplexityResponseAdapter
  implements LLMResponseAdapter<PerplexityResponse>
{
  readonly provider = "perplexity" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: PerplexityResponse) {
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
 * Perplexity stream adapter - wraps OpenAI adapter with Perplexity provider name.
 */
class PerplexityStreamAdapter
  implements LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse>
{
  readonly provider = "perplexity" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: PerplexityStreamChunk) {
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
    return new PerplexityRequestAdapter(request);
  },

  createResponseAdapter(
    response: PerplexityResponse,
  ): LLMResponseAdapter<PerplexityResponse> {
    return new PerplexityResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse> {
    return new PerplexityStreamAdapter();
  },

  extractApiKey(headers: PerplexityHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.perplexity.baseUrl;
  },

  getSpanName(): string {
    return "perplexity.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "perplexity",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? config.llm.perplexity.baseUrl,
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
    // Cast through unknown because PerplexityResponse uses .passthrough() which adds index signature
    return perplexityClient.chat.completions.create(
      perplexityRequest,
    ) as unknown as Promise<PerplexityResponse>;
  },

  async executeStream(
    client: unknown,
    request: PerplexityRequest,
  ): Promise<AsyncIterable<PerplexityStreamChunk>> {
    const perplexityClient = client as OpenAIProvider;
    const perplexityRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
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
