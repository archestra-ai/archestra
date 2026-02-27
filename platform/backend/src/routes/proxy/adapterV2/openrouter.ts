/**
 * OpenRouter LLM Proxy Adapter - OpenAI-compatible
 *
 * OpenRouter exposes an OpenAI-compatible API at https://openrouter.ai/api/v1
 * and recommends attribution headers (HTTP-Referer, X-Title).
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
  Openrouter,
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

type OpenrouterRequest = Openrouter.Types.ChatCompletionsRequest;
type OpenrouterResponse = Openrouter.Types.ChatCompletionsResponse;
type OpenrouterMessages = Openrouter.Types.ChatCompletionsRequest["messages"];
type OpenrouterHeaders = Openrouter.Types.ChatCompletionsHeaders;
type OpenrouterStreamChunk = Openrouter.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

class OpenrouterRequestAdapter
  implements LLMRequestAdapter<OpenrouterRequest, OpenrouterMessages>
{
  readonly provider = "openrouter" as const;
  private delegate: OpenAIRequestAdapter;

  constructor(request: OpenrouterRequest) {
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
  convertToolResultContent(messages: OpenrouterMessages) {
    return this.delegate.convertToolResultContent(messages);
  }
  toProviderRequest() {
    return this.delegate.toProviderRequest();
  }
}

class OpenrouterResponseAdapter
  implements LLMResponseAdapter<OpenrouterResponse>
{
  readonly provider = "openrouter" as const;
  private delegate: OpenAIResponseAdapter;

  constructor(response: OpenrouterResponse) {
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

class OpenrouterStreamAdapter
  implements LLMStreamAdapter<OpenrouterStreamChunk, OpenrouterResponse>
{
  readonly provider = "openrouter" as const;
  private delegate: OpenAIStreamAdapter;

  constructor() {
    this.delegate = new OpenAIStreamAdapter();
  }

  get state() {
    return this.delegate.state;
  }

  processChunk(chunk: OpenrouterStreamChunk) {
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
  OpenrouterRequest,
  OpenrouterResponse,
  OpenrouterMessages,
  OpenrouterStreamChunk,
  OpenrouterHeaders
> = {
  provider: "openrouter",
  interactionType: "openrouter:chatCompletions",

  createRequestAdapter(
    request: OpenrouterRequest,
  ): LLMRequestAdapter<OpenrouterRequest, OpenrouterMessages> {
    return new OpenrouterRequestAdapter(request);
  },

  createResponseAdapter(
    response: OpenrouterResponse,
  ): LLMResponseAdapter<OpenrouterResponse> {
    return new OpenrouterResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    OpenrouterStreamChunk,
    OpenrouterResponse
  > {
    return new OpenrouterStreamAdapter();
  },

  extractApiKey(headers: OpenrouterHeaders): string | undefined {
    const record = headers as unknown as Record<string, unknown>;
    const auth = record.authorization ?? record.Authorization;
    if (typeof auth !== "string") return undefined;

    // Fastify/Zod headers schemas may strip the "Bearer " prefix via transforms.
    // Our proxy handler already strips Bearer when resolving virtual keys, but
    // we must still send a proper Authorization header to OpenRouter upstream.
    return /^Bearer\s+/i.test(auth) ? auth : `Bearer ${auth}`;
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

    // The OpenAI SDK expects a raw key and will construct `Authorization: Bearer <key>`.
    // Some upstream plumbing may already provide a Bearer-prefixed value; strip it to
    // avoid `Bearer Bearer <key>`.
    const rawApiKey = apiKey.replace(/^Bearer\s+/i, "");

    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "openrouter",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    const attributionHeaders: Record<string, string> = {
      ...(config.llm.openrouter.referer
        ? { "HTTP-Referer": config.llm.openrouter.referer }
        : {}),
      ...(config.llm.openrouter.title
        ? { "X-Title": config.llm.openrouter.title }
        : {}),
    };

    return new OpenAIProvider({
      apiKey: rawApiKey,
      baseURL: options?.baseUrl ?? config.llm.openrouter.baseUrl,
      fetch: customFetch,
      defaultHeaders: {
        ...attributionHeaders,
        ...(options?.defaultHeaders ?? {}),
      },
    });
  },

  async execute(
    client: unknown,
    request: OpenrouterRequest,
  ): Promise<OpenrouterResponse> {
    const openrouterClient = client as OpenAIProvider;
    const openrouterRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await openrouterClient.chat.completions.create(
      openrouterRequest,
    )) as unknown as OpenrouterResponse;
  },

  async executeStream(
    client: unknown,
    request: OpenrouterRequest,
  ): Promise<AsyncIterable<OpenrouterStreamChunk>> {
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
          yield chunk as OpenrouterStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    const message = get(error, "error.message");
    if (typeof message === "string") {
      return message;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
