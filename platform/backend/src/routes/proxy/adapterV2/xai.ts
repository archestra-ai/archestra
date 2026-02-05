/**
 * x.ai (Grok) LLM Proxy Adapter - OpenAI-compatible
 *
 * x.ai uses an OpenAI-compatible API at https://api.x.ai/v1
 * This adapter reuses OpenAI's adapter factory with x.ai-specific configuration.
 *
 * Since x.ai is 100% OpenAI-compatible, we delegate all adapter logic to OpenAI
 * and only override the provider-specific configuration (baseUrl, provider name, etc.).
 *
 * @see https://docs.x.ai/api
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
  Xai,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since x.ai is OpenAI-compatible)
// =============================================================================

type XaiRequest = Xai.Types.ChatCompletionsRequest;
type XaiResponse = Xai.Types.ChatCompletionsResponse;
type XaiMessages = Xai.Types.ChatCompletionsRequest["messages"];
type XaiHeaders = Xai.Types.ChatCompletionsHeaders;
type XaiStreamChunk = Xai.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

/**
 * x.ai request adapter - wraps OpenAI adapter with x.ai provider name.
 * Uses composition to delegate all logic to OpenAI since APIs are identical.
 */
class XaiRequestAdapter
  implements LLMRequestAdapter<XaiRequest, XaiMessages>
{
  readonly provider = "xai" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: XaiRequest) {
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
  convertToolResultContent(messages: XaiMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

/**
 * x.ai response adapter - wraps OpenAI adapter with x.ai provider name.
 */
class XaiResponseAdapter implements LLMResponseAdapter<XaiResponse> {
  readonly provider = "xai" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: XaiResponse) {
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
 * x.ai stream adapter - wraps OpenAI adapter with x.ai provider name.
 */
class XaiStreamAdapter
  implements LLMStreamAdapter<XaiStreamChunk, XaiResponse>
{
  readonly provider = "xai" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: XaiStreamChunk) {
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
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.xai.baseUrl;
  },

  getSpanName(): string {
    return "xai.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? getObservableFetch("xai", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl ?? config.llm.xai.baseUrl,
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
    // Cast through unknown because XaiResponse uses .passthrough() which adds index signature
    return xaiClient.chat.completions.create(
      xaiRequest,
    ) as unknown as Promise<XaiResponse>;
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
