/**
 * xAI LLM Proxy Adapter - OpenAI-compatible
 *
 * xAI uses an OpenAI-compatible API at https://api.x.ai/v1
 * This adapter delegates request/response/stream parsing to the OpenAI adapters
 * and only overrides provider-specific configuration (baseUrl, api key behavior).
 */

import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { metrics } from "@/observability";
import {
  decodeXaiSubscriptionCredential,
  isXaiSubscriptionCredential,
} from "@/services/xai-subscription-credentials";
import { createXaiSubscriptionFetch } from "@/services/xai-subscription-token";
import {
  ApiError,
  type CreateClientOptions,
  type LLMProvider,
  type LLMRequestAdapter,
  type LLMResponseAdapter,
  type LLMStreamAdapter,
  type Xai,
} from "@/types";
import {
  OpenAIRequestAdapter,
  OpenAIResponseAdapter,
  OpenAIStreamAdapter,
} from "./openai";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

// =============================================================================
// TYPE ALIASES (reuse OpenAI types since xAI is OpenAI-compatible)
// =============================================================================

type XaiRequest = Xai.Types.ChatCompletionsRequest;
type XaiResponse = Xai.Types.ChatCompletionsResponse;
type XaiMessages = Xai.Types.ChatCompletionsRequest["messages"];
type XaiHeaders = Xai.Types.ChatCompletionsHeaders;
type XaiStreamChunk = Xai.Types.ChatCompletionChunk;

// =============================================================================
// ADAPTER CLASSES (delegate to OpenAI adapters, override provider)
// =============================================================================

class XaiRequestAdapter implements LLMRequestAdapter<XaiRequest, XaiMessages> {
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
  getFinishReasons() {
    return this.delegate.getFinishReasons();
  }
  toRefusalResponse(refusalMessage: string, contentMessage: string) {
    return this.delegate.toRefusalResponse(refusalMessage, contentMessage);
  }
}

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

/**
 * `extractApiKey` returns the authorization header verbatim, so a credential can
 * reach the adapter with a `Bearer ` transport prefix. Both the billing-mode
 * classification and the client construction read through this, so a credential
 * can never be billed as a subscription while being sent as a raw bearer.
 */
function stripBearerPrefix(apiKey: string | undefined): string | undefined {
  return apiKey?.startsWith("Bearer ") ? apiKey.slice(7) : apiKey;
}

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
    // xAI requires auth.
    return headers.authorization;
  },

  isSubscriptionCredential(apiKey: string | undefined): boolean {
    // X Premium (SuperGrok) credentials travel through the proxy as
    // marker-prefixed encoded strings (`xai-subscription:…`). They are covered
    // by a flat-rate plan, so they must classify as subscription — the same rule
    // as ChatGPT/Codex credentials on the openai adapter. Plain console API keys
    // stay metered.
    return isXaiSubscriptionCredential(stripBearerPrefix(apiKey));
  },

  getBaseUrl(): string | undefined {
    return config.llm.xai.baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    if (!apiKey) {
      throw new Error("API key required for xAI");
    }

    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("xai", options.agent, options.source)
      : undefined;

    // "X Premium (SuperGrok)" subscription auth mode: the resolved credential is
    // an encoded xAI OAuth credential, not a console key. The base URL is the
    // same OpenAI-compatible surface either way — only the bearer differs, and
    // it is swapped in the fetch wrapper because createClient is synchronous.
    const strippedApiKey = stripBearerPrefix(apiKey);
    const subscriptionCredential =
      decodeXaiSubscriptionCredential(strippedApiKey);
    // A marker-prefixed value that doesn't decode is a corrupted subscription
    // credential, never a console key: falling through to the plain-key branch
    // would send it as a raw bearer to options.baseUrl, which per-key
    // overrides make user-supplied — the exact leak the subscription fetch's
    // origin pin fails closed against.
    if (
      !subscriptionCredential &&
      isXaiSubscriptionCredential(strippedApiKey)
    ) {
      throw new ApiError(
        401,
        "Your X Premium (SuperGrok) sign-in is unreadable. Reconnect your X account to keep using your subscription.",
        ArchestraInternalErrorCode.ProviderAuthRequired,
      );
    }
    if (subscriptionCredential) {
      return new OpenAIProvider({
        maxRetries: PROXY_SDK_MAX_RETRIES,
        // Placeholder satisfies the SDK; the wrapper sets the real bearer.
        apiKey: "xai-subscription",
        baseURL: options.baseUrl,
        fetch: createXaiSubscriptionFetch({
          credential: subscriptionCredential,
          providerApiKeyId: options.llmProviderApiKeyId,
          innerFetch: customFetch,
        }),
        defaultHeaders: options.defaultHeaders,
      });
    }

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey,
      baseURL: options.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },

  async execute(client: unknown, request: XaiRequest): Promise<XaiResponse> {
    const xaiClient = client as OpenAIProvider;
    const xaiRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;

    return (await xaiClient.chat.completions.create(
      xaiRequest,
    )) as unknown as XaiResponse;
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

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    if (get(error, "error.code") === "context_length_exceeded") {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    // The X Premium (SuperGrok) fetch wrapper reports a dead sign-in
    // (expired/revoked refresh token) as a synthetic 401 whose body carries the
    // normalized code; relay it so the chat mapper renders the reconnect card.
    if (
      get(error, "error.internal_code") ===
      ArchestraInternalErrorCode.ProviderAuthRequired
    ) {
      return ArchestraInternalErrorCode.ProviderAuthRequired;
    }
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    const xaiMessage = get(error, "error.message");
    if (typeof xaiMessage === "string") {
      return xaiMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
