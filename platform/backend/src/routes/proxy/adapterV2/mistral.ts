/**
 * Mistral LLM Proxy Adapter - OpenAI-compatible
 *
 * Mistral uses an OpenAI-compatible API at https://api.mistral.ai/v1
 * This adapter reuses OpenAI's adapter factory with Mistral-specific configuration.
 *
 * Since Mistral is 100% OpenAI-compatible, we delegate all adapter logic to OpenAI
 * and only override the provider-specific configuration (baseUrl, provider name, etc.).
 *
 * @see https://docs.mistral.ai/api
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
  Mistral,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since Mistral is OpenAI-compatible)
// =============================================================================

type MistralRequest = Mistral.Types.ChatCompletionsRequest;
type MistralResponse = Mistral.Types.ChatCompletionsResponse;
type MistralMessages = Mistral.Types.ChatCompletionsRequest["messages"];
type MistralHeaders = Mistral.Types.ChatCompletionsHeaders;
type MistralStreamChunk = Mistral.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

/**
 * Mistral request adapter - wraps OpenAI adapter with Mistral provider name.
 * Uses composition to delegate all logic to OpenAI since APIs are identical.
 */
class MistralRequestAdapter
  implements LLMRequestAdapter<MistralRequest, MistralMessages>
{
  readonly provider = "mistral" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: MistralRequest) {
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
  convertToolResultContent(messages: MistralMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

/**
 * Mistral response adapter - wraps OpenAI adapter with Mistral provider name.
 */
class MistralResponseAdapter implements LLMResponseAdapter<MistralResponse> {
  readonly provider = "mistral" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: MistralResponse) {
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
 * Mistral stream adapter - wraps OpenAI adapter with Mistral provider name.
 */
class MistralStreamAdapter
  implements LLMStreamAdapter<MistralStreamChunk, MistralResponse>
{
  readonly provider = "mistral" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: MistralStreamChunk) {
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

export const mistralAdapterFactory: LLMProvider<
  MistralRequest,
  MistralResponse,
  MistralMessages,
  MistralStreamChunk,
  MistralHeaders
> = {
  provider: "mistral",
  interactionType: "mistral:chatCompletions",

  createRequestAdapter(
    request: MistralRequest,
  ): LLMRequestAdapter<MistralRequest, MistralMessages> {
    return new MistralRequestAdapter(request);
  },

  createResponseAdapter(
    response: MistralResponse,
  ): LLMResponseAdapter<MistralResponse> {
    return new MistralResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<MistralStreamChunk, MistralResponse> {
    return new MistralStreamAdapter();
  },

  extractApiKey(headers: MistralHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.mistral.baseUrl;
  },

  getSpanName(): string {
    return "mistral.chat.completions";
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
          "mistral",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? config.llm.mistral.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: MistralRequest,
  ): Promise<MistralResponse> {
    const mistralClient = client as OpenAIProvider;
    const mistralRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    // Cast through unknown because MistralResponse uses .passthrough() which adds index signature
    return mistralClient.chat.completions.create(
      mistralRequest,
    ) as unknown as Promise<MistralResponse>;
  },

  async executeStream(
    client: unknown,
    request: MistralRequest,
  ): Promise<AsyncIterable<MistralStreamChunk>> {
    const mistralClient = client as OpenAIProvider;
    const mistralRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await mistralClient.chat.completions.create(mistralRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as MistralStreamChunk;
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
