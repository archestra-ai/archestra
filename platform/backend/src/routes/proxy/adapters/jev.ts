/**
 * Jev LLM Proxy Adapter - decisions only
 *
 * Jev answers typed questions about a piece of state with probabilities. The
 * proxy forwards a decisions request as is to the configured endpoint — a full
 * URL, since TypeSafe (`/v1/systemone`) and OpenRouter (`/api/alpha/decisions`)
 * serve the same wire format at different paths — and logs it like any other
 * interaction. There are no messages, tool calls, or streaming.
 *
 * The OpenAI SDK is only the HTTP client here: its generic `post` gives the
 * proxy the shared retry policy, the observable fetch, and an `APIError` that
 * carries the upstream status, so error handling matches the other providers.
 */
import OpenAIProvider from "openai";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  Jev,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import { openaiAdapterFactory } from "./openai";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

type JevRequest = Jev.Types.DecisionsRequest;
type JevResponse = Jev.Types.DecisionsResponse;
type JevHeaders = Jev.Types.DecisionsHeaders;
/** Decisions carry no conversation; the state stands in as one user turn. */
type JevMessages = CommonMessage[];

export const jevAdapterFactory: LLMProvider<
  JevRequest,
  JevResponse,
  JevMessages,
  never,
  JevHeaders
> = {
  provider: "jev",
  interactionType: "jev:decisions",

  createRequestAdapter(request) {
    return new JevRequestAdapter(request);
  },

  createResponseAdapter(response) {
    return new JevResponseAdapter(response);
  },

  createStreamAdapter() {
    return new JevStreamAdapter();
  },

  extractApiKey(headers) {
    return headers.authorization;
  },

  getBaseUrl() {
    return config.llm.jev.baseUrl;
  },

  spanName: "generate_content",

  createClient(apiKey: string | undefined, options: CreateClientOptions) {
    if (!apiKey) {
      throw new Error("API key required for Jev");
    }
    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("jev", options.agent, options.source)
      : undefined;

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey: apiKey.replace(/^Bearer\s+/i, ""),
      baseURL: options.baseUrl || config.llm.jev.baseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },

  async execute(client, request) {
    const sdk = client as OpenAIProvider;
    // The base URL is the whole endpoint, so the request goes to it as is.
    return sdk.post<JevResponse>(sdk.baseURL, { body: request });
  },

  async executeStream(): Promise<AsyncIterable<never>> {
    throw new Error("Jev decisions do not support streaming.");
  },

  extractInternalCode(error) {
    return openaiAdapterFactory.extractInternalCode(error);
  },

  extractErrorMessage(error) {
    return openaiAdapterFactory.extractErrorMessage(error);
  },
};

// =============================================================================
// ADAPTER CLASSES
// =============================================================================

class JevRequestAdapter implements LLMRequestAdapter<JevRequest, JevMessages> {
  readonly provider = "jev" as const;
  private request: JevRequest;
  private modifiedModel: string | null = null;

  constructor(request: JevRequest) {
    this.request = request;
  }

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return false;
  }

  getMessages(): CommonMessage[] {
    return this.getProviderMessages();
  }

  getToolResults(): CommonToolResult[] {
    return [];
  }

  getTools(): CommonMcpToolDefinition[] {
    return [];
  }

  hasTools(): boolean {
    return false;
  }

  getProviderMessages(): JevMessages {
    const { state } = this.request;
    return [
      {
        role: "user",
        content: typeof state === "string" ? state : JSON.stringify(state),
      },
    ];
  }

  getOriginalRequest(): JevRequest {
    return this.request;
  }

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(): void {}

  applyToolResultUpdates(): void {}

  convertToolResultContent(messages: JevMessages): JevMessages {
    return messages;
  }

  toProviderRequest(): JevRequest {
    return { ...this.request, model: this.getModel() };
  }
}

class JevResponseAdapter implements LLMResponseAdapter<JevResponse> {
  readonly provider = "jev" as const;
  private response: JevResponse;

  constructor(response: JevResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id ?? "";
  }

  getModel(): string {
    return this.response.model ?? "";
  }

  getText(): string {
    return "";
  }

  getToolCalls(): CommonToolCall[] {
    return [];
  }

  hasToolCalls(): boolean {
    return false;
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.usage?.input_tokens ?? 0,
      outputTokens: this.response.usage?.output_tokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  getOriginalResponse(): JevResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    return [];
  }

  toRefusalResponse(): JevResponse {
    return this.response;
  }
}

class JevStreamAdapter implements LLMStreamAdapter<never, JevResponse> {
  readonly provider = "jev" as const;
  readonly state: StreamAccumulatorState = {
    responseId: "",
    model: "",
    text: "",
    toolCalls: [],
    rawToolCallEvents: [],
    usage: null,
    stopReason: null,
    timing: { startTime: Date.now(), firstChunkTime: null },
  };

  processChunk(): ChunkProcessingResult {
    throw new Error("Jev decisions do not support streaming.");
  }

  getSSEHeaders(): Record<string, string> {
    throw new Error("Jev decisions do not support streaming.");
  }

  formatTextDeltaSSE(): string {
    throw new Error("Jev decisions do not support streaming.");
  }

  getRawToolCallEvents(): string[] {
    return [];
  }

  formatCompleteTextSSE(): string[] {
    throw new Error("Jev decisions do not support streaming.");
  }

  formatEndSSE(): string {
    throw new Error("Jev decisions do not support streaming.");
  }

  toProviderResponse(): JevResponse {
    throw new Error("Jev decisions do not support streaming.");
  }
}
