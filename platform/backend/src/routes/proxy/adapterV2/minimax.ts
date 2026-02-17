/**
 * MiniMax LLM Proxy Adapter - OpenAI-compatible
 *
 * MiniMax uses an OpenAI-compatible API at https://api.minimax.chat/v1
 * This adapter reuses OpenAI's adapter factory with MiniMax-specific configuration.
 *
 * Since MiniMax is 100% OpenAI-compatible, we delegate all adapter logic to OpenAI
 * and only override the provider-specific configuration (baseUrl, provider name, etc.).
 *
 * @see https://platform.minimax.io/docs/api-reference/text-openai-api
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
  MiniMax,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since MiniMax is OpenAI-compatible)
// =============================================================================

type MiniMaxRequest = MiniMax.Types.ChatCompletionsRequest;
type MiniMaxResponse = MiniMax.Types.ChatCompletionsResponse;
type MiniMaxMessages = MiniMax.Types.ChatCompletionsRequest["messages"];
type MiniMaxHeaders = MiniMax.Types.ChatCompletionsHeaders;
type MiniMaxStreamChunk = MiniMax.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

/**
 * MiniMax request adapter - wraps OpenAI adapter with MiniMax provider name.
 * Uses composition to delegate all logic to OpenAI since APIs are identical.
 */
class MiniMaxRequestAdapter
  implements LLMRequestAdapter<MiniMaxRequest, MiniMaxMessages>
{
  readonly provider = "minimax" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: MiniMaxRequest) {
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
  convertToolResultContent(messages: MiniMaxMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

/**
 * MiniMax response adapter - wraps OpenAI adapter with MiniMax provider name.
 */
class MiniMaxResponseAdapter implements LLMResponseAdapter<MiniMaxResponse> {
  readonly provider = "minimax" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: MiniMaxResponse) {
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
 * MiniMax stream adapter - wraps OpenAI adapter with MiniMax provider name.
 */
class MiniMaxStreamAdapter
  implements LLMStreamAdapter<MiniMaxStreamChunk, MiniMaxResponse>
{
  readonly provider = "minimax" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: MiniMaxStreamChunk) {
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

export const minimaxAdapterFactory: LLMProvider<
  MiniMaxRequest,
  MiniMaxResponse,
  MiniMaxMessages,
  MiniMaxStreamChunk,
  MiniMaxHeaders
> = {
  provider: "minimax",
  interactionType: "minimax:chatCompletions",

  createRequestAdapter(
    request: MiniMaxRequest,
  ): LLMRequestAdapter<MiniMaxRequest, MiniMaxMessages> {
    return new MiniMaxRequestAdapter(request);
  },

  createResponseAdapter(
    response: MiniMaxResponse,
  ): LLMResponseAdapter<MiniMaxResponse> {
    return new MiniMaxResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<MiniMaxStreamChunk, MiniMaxResponse> {
    return new MiniMaxStreamAdapter();
  },

  extractApiKey(headers: MiniMaxHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.minimax.baseUrl;
  },

  getSpanName(): string {
    return "minimax.chat.completions";
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
          "minimax",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? config.llm.minimax.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: MiniMaxRequest,
  ): Promise<MiniMaxResponse> {
    const minimaxClient = client as OpenAIProvider;
    const minimaxRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    // Cast through unknown because MiniMaxResponse uses .passthrough() which adds index signature
    return minimaxClient.chat.completions.create(
      minimaxRequest,
    ) as unknown as Promise<MiniMaxResponse>;
  },

  async executeStream(
    client: unknown,
    request: MiniMaxRequest,
  ): Promise<AsyncIterable<MiniMaxStreamChunk>> {
    const minimaxClient = client as OpenAIProvider;
    const minimaxRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await minimaxClient.chat.completions.create(minimaxRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as MiniMaxStreamChunk;
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
