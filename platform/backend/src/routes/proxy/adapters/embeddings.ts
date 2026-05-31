/**
 * Provider-agnostic embedding adapter factory for the model router.
 *
 * Wraps the knowledge-base `callEmbedding` clients so that any provider with
 * embedding models can be served through the OpenAI-compatible
 * `POST /v1/model-router/{id}/embeddings` endpoint while preserving the full
 * `handleLLMProxy` pipeline (interaction logging, cost tracking, rate limiting,
 * observability, etc.).
 *
 * Supported providers:
 *   - openai   — OpenAI /v1/embeddings
 *   - azure    — Azure OpenAI /v1/embeddings (handles Entra ID + api-key auth)
 *   - gemini   — Google GenAI embedContent (text + multimodal)
 *   - All other OpenAI-wire providers (mistral, ollama, vllm, groq, etc.)
 *     use the OpenAI-compatible /v1/embeddings endpoint via callOpenAIEmbedding.
 */

import type { SupportedProvider, SupportedProviderDiscriminator } from "@shared";
import type {
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import type { CommonMessage, CommonMcpToolDefinition, CommonToolCall, CommonToolResult } from "@/types";
import {
  callEmbedding,
  getEmbeddingDiscriminator,
} from "@/knowledge-base/embedding-clients";
import type { EmbeddingApiResponse } from "@/knowledge-base/embedding-clients";

// ---------------------------------------------------------------------------
// Type aliases
// ---------------------------------------------------------------------------

type EmbeddingRequest = OpenAi.Types.EmbeddingRequest;
type EmbeddingResponse = OpenAi.Types.EmbeddingResponse;
type EmbeddingHeaders = OpenAi.Types.ChatCompletionsHeaders;

/**
 * Minimal client shape passed through handleLLMProxy.
 * We only need the API key and base URL to call `callEmbedding`.
 */
type EmbeddingClient = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
};

// ---------------------------------------------------------------------------
// Request adapter
// ---------------------------------------------------------------------------

class EmbeddingRequestAdapter
  implements LLMRequestAdapter<EmbeddingRequest, never[]>
{
  readonly provider: SupportedProvider;
  private request: EmbeddingRequest;
  private modifiedModel: string | null = null;

  constructor(request: EmbeddingRequest, provider: SupportedProvider) {
    this.request = request;
    this.provider = provider;
  }

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return false;
  }

  getMessages(): CommonMessage[] {
    return this.getInputStrings().map((content) => ({
      role: "user" as const,
      content,
    }));
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

  getProviderMessages(): never[] {
    return [];
  }

  getOriginalRequest(): EmbeddingRequest {
    return this.request;
  }

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(): void {}

  applyToolResultUpdates(): void {}

  async applyToonCompression(): Promise<ToolCompressionStats> {
    return {
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    };
  }

  convertToolResultContent(messages: never[]): never[] {
    return messages;
  }

  toProviderRequest(): EmbeddingRequest {
    return {
      ...this.request,
      model: this.getModel(),
    };
  }

  private getInputStrings(): string[] {
    return Array.isArray(this.request.input)
      ? this.request.input
      : [this.request.input];
  }
}

// ---------------------------------------------------------------------------
// Response adapter
// ---------------------------------------------------------------------------

class EmbeddingResponseAdapter
  implements LLMResponseAdapter<EmbeddingResponse>
{
  readonly provider: SupportedProvider;
  private response: EmbeddingResponse;

  constructor(response: EmbeddingResponse, provider: SupportedProvider) {
    this.response = response;
    this.provider = provider;
  }

  getId(): string {
    return "";
  }

  getModel(): string {
    return this.response.model;
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
      inputTokens: this.response.usage.prompt_tokens,
      outputTokens: 0,
    };
  }

  getOriginalResponse(): EmbeddingResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    return [];
  }

  toRefusalResponse(): EmbeddingResponse {
    return this.response;
  }
}

// ---------------------------------------------------------------------------
// Stream adapter (embeddings never stream)
// ---------------------------------------------------------------------------

class EmbeddingStreamAdapter
  implements LLMStreamAdapter<never, EmbeddingResponse>
{
  readonly provider: SupportedProvider;
  readonly state: StreamAccumulatorState = {
    responseId: "",
    model: "",
    text: "",
    toolCalls: [],
    rawToolCallEvents: [],
    usage: null,
    stopReason: null,
  };

  constructor(provider: SupportedProvider) {
    this.provider = provider;
  }

  processChunk(): { type: "text_delta"; text: string } {
    return { type: "text_delta", text: "" };
  }

  getSSEHeaders(): Record<string, string> {
    return { "content-type": "text/event-stream" };
  }

  formatTextDeltaSSE(text: string): string {
    return `data: ${text}\n\n`;
  }

  getRawToolCallEvents(): never[] {
    return [];
  }

  formatCompleteTextSSE(text: string): string {
    return `data: ${text}\n\n`;
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): EmbeddingResponse {
    return {
      object: "list",
      data: [],
      model: this.state.model,
      usage: { prompt_tokens: 0, total_tokens: 0 },
    };
  }
}

// ---------------------------------------------------------------------------
// Factory builder
// ---------------------------------------------------------------------------

/**
 * Builds an `LLMProvider` adapter factory for embeddings for the given provider.
 *
 * The factory delegates the actual HTTP call to `callEmbedding` from the
 * knowledge-base embedding clients, which already handles OpenAI, Azure, and
 * Gemini correctly. All other providers fall back to the OpenAI-compatible
 * embeddings endpoint via `callOpenAIEmbedding`.
 */
export function makeEmbeddingAdapterFactory(
  provider: SupportedProvider,
  getBaseUrl: () => string | undefined,
): LLMProvider<EmbeddingRequest, EmbeddingResponse, never[], never, EmbeddingHeaders> {
  const interactionType = getEmbeddingInteractionType(provider);

  return {
    provider,
    interactionType,

    createRequestAdapter(request: EmbeddingRequest) {
      return new EmbeddingRequestAdapter(request, provider);
    },

    createResponseAdapter(response: EmbeddingResponse) {
      return new EmbeddingResponseAdapter(response, provider);
    },

    createStreamAdapter() {
      return new EmbeddingStreamAdapter(provider);
    },

    extractApiKey(headers: EmbeddingHeaders): string | undefined {
      return headers.authorization;
    },

    getBaseUrl,

    spanName: "embedding",

    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): EmbeddingClient {
      return {
        apiKey,
        baseUrl: options.baseUrl,
      };
    },

    async execute(
      client: unknown,
      request: EmbeddingRequest,
    ): Promise<EmbeddingResponse> {
      const { apiKey, baseUrl } = client as EmbeddingClient;

      const inputs = Array.isArray(request.input)
        ? request.input
        : [request.input];

      const result: EmbeddingApiResponse = await callEmbedding({
        inputs,
        model: request.model,
        apiKey: apiKey ?? "",
        baseUrl: baseUrl ?? null,
        dimensions: request.dimensions ?? undefined,
        provider,
      });

      return {
        object: result.object,
        data: result.data,
        model: result.model,
        usage: {
          prompt_tokens: result.usage.prompt_tokens,
          total_tokens: result.usage.total_tokens,
        },
      };
    },

    async executeStream(): Promise<AsyncIterable<never>> {
      throw new Error(`${provider} embeddings do not support streaming.`);
    },

    extractInternalCode() {
      return undefined;
    },

    extractErrorMessage(error: unknown): string {
      if (error instanceof Error) return error.message;
      return "Internal server error";
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getEmbeddingInteractionType(
  provider: SupportedProvider,
): SupportedProviderDiscriminator {
  return getEmbeddingDiscriminator(provider);
}
