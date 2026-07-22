/**
 * Bedrock InvokeModel adapter (Anthropic Messages wire format).
 *
 * Bedrock's native InvokeModel API for Anthropic models speaks the Anthropic
 * Messages API format — it is what the Anthropic SDK's Bedrock client (and
 * therefore Claude Code with `CLAUDE_CODE_USE_BEDROCK=1`) sends to
 * `/model/:modelId/invoke` and `/model/:modelId/invoke-with-response-stream`.
 *
 * This adapter delegates all request/response/stream semantics (policy
 * evaluation, TOON compression, accumulation, refusals) to the existing
 * Anthropic adapters and only changes the transport:
 * - upstream requests go through `BedrockClient` (Bearer/SigV4/IAM auth) with
 *   the model in the URL, `anthropic_version` in the body, and no `model`,
 *   `stream`, or internal fields in the body
 * - the streaming wire format to the client is the AWS event stream framing
 *   Bedrock uses for InvokeModel: "chunk" events carrying
 *   `{ bytes: "<base64 of an Anthropic stream event JSON>" }`
 */

import type AnthropicProvider from "@anthropic-ai/sdk";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import type { BedrockClient } from "@/clients/bedrock-client";
import type {
  Anthropic,
  Bedrock,
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { anthropicAdapterFactory } from "./anthropic";
import { bedrockAdapterFactory } from "./bedrock";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];
type AnthropicStreamChunk = AnthropicProvider.Messages.MessageStreamEvent;
type BedrockHeaders = Bedrock.Types.ConverseHeaders;

/**
 * The request the routes hand to `handleLLMProxy`: the Anthropic Messages
 * request (with `model` already injected from the URL path) plus the
 * Bedrock-specific body fields and the internal streaming flag.
 */
type BedrockInvokeRequest = AnthropicRequest & {
  anthropic_version?: string;
  anthropic_beta?: string[];
  _isStreaming?: boolean;
};

// Default protocol version for Anthropic models on Bedrock; clients normally
// send it themselves but the upstream call fails without one.
const BEDROCK_ANTHROPIC_VERSION = "bedrock-2023-05-31";

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const bedrockInvokeAdapterFactory: LLMProvider<
  BedrockInvokeRequest,
  AnthropicResponse,
  AnthropicMessages,
  AnthropicStreamChunk,
  BedrockHeaders
> = {
  provider: "bedrock",
  interactionType: "bedrock:invoke",
  // Same rationale as the Converse adapter: the custom SigV4 client can't
  // self-instrument the request-duration metric, so the LLM proxy handler
  // records `llm_request_duration_seconds` on its behalf.
  recordRequestDurationInHandler: true,
  spanName: "chat",

  createRequestAdapter(
    request: BedrockInvokeRequest,
  ): LLMRequestAdapter<BedrockInvokeRequest, AnthropicMessages> {
    return new BedrockInvokeRequestAdapter(request);
  },

  createResponseAdapter(
    response: AnthropicResponse,
  ): LLMResponseAdapter<AnthropicResponse> {
    return new BedrockInvokeResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    AnthropicStreamChunk,
    AnthropicResponse
  > {
    return new BedrockInvokeStreamAdapter();
  },

  extractApiKey(headers: BedrockHeaders): string | undefined {
    return bedrockAdapterFactory.extractApiKey(headers);
  },

  getBaseUrl(): string | undefined {
    return bedrockAdapterFactory.getBaseUrl();
  },

  createClient(...args: Parameters<typeof bedrockAdapterFactory.createClient>) {
    return bedrockAdapterFactory.createClient(...args);
  },

  async execute(
    client: unknown,
    request: BedrockInvokeRequest,
  ): Promise<AnthropicResponse> {
    const bedrockClient = client as BedrockClient;
    const response = await bedrockClient.invoke(
      request.model,
      toInvokeBody(request),
    );
    return {
      ...response,
      // Anthropic-on-Bedrock responses carry these, but default defensively:
      // both are required by the response schema the route serializes with.
      model: response.model ?? request.model,
      stop_sequence: response.stop_sequence ?? null,
    };
  },

  async executeStream(
    client: unknown,
    request: BedrockInvokeRequest,
  ): Promise<AsyncIterable<AnthropicStreamChunk>> {
    const bedrockClient = client as BedrockClient;
    return bedrockClient.invokeStream(request.model, toInvokeBody(request));
  },

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    // BedrockClient throws plain Errors whose message embeds the upstream
    // detail (see buildBedrockErrorMessage). Context overflow surfaces as
    // "prompt is too long: X tokens > Y maximum." or
    // "model_context_window_exceeded" depending on the model.
    if (!(error instanceof Error)) return undefined;
    const msg = error.message.toLowerCase();
    if (
      msg.includes("too long") ||
      msg.includes("model_context_window_exceeded")
    ) {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    return bedrockAdapterFactory.extractErrorMessage(error);
  },
};

// =============================================================================
// REQUEST BODY TRANSLATION
// =============================================================================

/**
 * Build the InvokeModel body from the (possibly policy-modified) Anthropic
 * request: the model moves to the URL, streaming is endpoint-selected, and
 * internal flags never reach the provider. Bedrock rejects unknown top-level
 * fields ("Extra inputs are not permitted"), so `model`/`stream`/`_isStreaming`
 * must all be stripped.
 */
function toInvokeBody(request: BedrockInvokeRequest): Record<string, unknown> {
  const {
    model: _model,
    stream: _stream,
    _isStreaming,
    ...rest
  } = request as Record<string, unknown>;
  return { anthropic_version: BEDROCK_ANTHROPIC_VERSION, ...rest };
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class BedrockInvokeRequestAdapter
  implements LLMRequestAdapter<BedrockInvokeRequest, AnthropicMessages>
{
  readonly provider = "bedrock" as const;
  private request: BedrockInvokeRequest;
  private inner: LLMRequestAdapter<AnthropicRequest, AnthropicMessages>;

  constructor(request: BedrockInvokeRequest) {
    this.request = request;
    this.inner = anthropicAdapterFactory.createRequestAdapter(request);
  }

  getModel(): string {
    return this.inner.getModel();
  }

  isStreaming(): boolean {
    // Streaming is endpoint-selected (invoke vs invoke-with-response-stream);
    // the routes inject this flag, mirroring the Converse routes.
    return this.request._isStreaming === true;
  }

  getMessages(): CommonMessage[] {
    return this.inner.getMessages();
  }

  getToolResults(): CommonToolResult[] {
    return this.inner.getToolResults();
  }

  getTools(): CommonMcpToolDefinition[] {
    return this.inner.getTools();
  }

  hasTools(): boolean {
    return this.inner.hasTools();
  }

  getProviderMessages(): AnthropicMessages {
    return this.inner.getProviderMessages();
  }

  getOriginalRequest(): BedrockInvokeRequest {
    return this.request;
  }

  setModel(model: string): void {
    this.inner.setModel(model);
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.inner.updateToolResult(toolCallId, newContent);
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    this.inner.applyToolResultUpdates(updates);
  }

  applyToonCompression(model: string): Promise<ToolCompressionStats> {
    return this.inner.applyToonCompression(model);
  }

  convertToolResultContent(messages: AnthropicMessages): AnthropicMessages {
    return this.inner.convertToolResultContent(messages);
  }

  toProviderRequest(): BedrockInvokeRequest {
    return this.inner.toProviderRequest();
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class BedrockInvokeResponseAdapter
  implements LLMResponseAdapter<AnthropicResponse>
{
  readonly provider = "bedrock" as const;
  private inner: LLMResponseAdapter<AnthropicResponse>;

  constructor(response: AnthropicResponse) {
    this.inner = anthropicAdapterFactory.createResponseAdapter(response);
  }

  getId(): string {
    return this.inner.getId();
  }

  getModel(): string {
    return this.inner.getModel();
  }

  getText(): string {
    return this.inner.getText();
  }

  getToolCalls(): CommonToolCall[] {
    return this.inner.getToolCalls();
  }

  hasToolCalls(): boolean {
    return this.inner.hasToolCalls();
  }

  getUsage(): UsageView {
    return this.inner.getUsage();
  }

  getOriginalResponse(): AnthropicResponse {
    return this.inner.getOriginalResponse();
  }

  getFinishReasons(): string[] {
    return this.inner.getFinishReasons();
  }

  toRefusalResponse(
    refusalMessage: string,
    contentMessage: string,
  ): AnthropicResponse {
    return this.inner.toRefusalResponse(refusalMessage, contentMessage);
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

/**
 * Wraps the Anthropic stream adapter, keeping all of its accumulation and
 * policy semantics, and re-frames every wire output from Anthropic SSE into
 * Bedrock's InvokeModel event stream ("chunk" events with base64 `bytes`).
 */
class BedrockInvokeStreamAdapter
  implements LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>
{
  readonly provider = "bedrock" as const;
  private inner: LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>;

  constructor() {
    this.inner = anthropicAdapterFactory.createStreamAdapter();
  }

  get state(): StreamAccumulatorState {
    return this.inner.state;
  }

  processChunk(chunk: AnthropicStreamChunk): ChunkProcessingResult {
    const result = this.inner.processChunk(chunk);
    return {
      ...result,
      sseData:
        result.sseData !== null
          ? sseToInvokeEventStream(innerSse(result.sseData))
          : null,
    };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/vnd.amazon.eventstream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "request-id": `req-proxy-${Date.now()}`,
    };
  }

  formatTextDeltaSSE(text: string): Uint8Array {
    return sseToInvokeEventStream(
      innerSse(this.inner.formatTextDeltaSSE(text)),
    );
  }

  getRawToolCallEvents(): Uint8Array[] {
    return this.inner
      .getRawToolCallEvents()
      .map((event) => sseToInvokeEventStream(innerSse(event)));
  }

  formatCompleteTextSSE(text: string): Uint8Array[] {
    return this.inner
      .formatCompleteTextSSE(text)
      .map((event) => sseToInvokeEventStream(innerSse(event)));
  }

  formatEndSSE(): Uint8Array {
    return sseToInvokeEventStream(innerSse(this.inner.formatEndSSE()));
  }

  toProviderResponse(): AnthropicResponse {
    return this.inner.toProviderResponse();
  }
}

// =============================================================================
// SSE → INVOKE EVENT STREAM ENCODING
// =============================================================================

const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

/** The Anthropic stream adapter emits SSE strings exclusively; narrow safely. */
function innerSse(value: string | Uint8Array): string {
  if (typeof value !== "string") {
    throw new Error("Expected SSE string from Anthropic stream adapter");
  }
  return value;
}

/**
 * Re-frame Anthropic SSE (one or more `event: X\ndata: {...}\n\n` blocks) as
 * Bedrock InvokeModel event stream messages: each Anthropic event JSON is
 * base64-encoded into a `{ bytes }` payload on a "chunk" event, exactly how
 * Bedrock frames invoke-with-response-stream responses.
 */
function sseToInvokeEventStream(sse: string): Uint8Array {
  const encoded: Uint8Array[] = [];
  for (const line of sse.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    encoded.push(encodeInvokeChunk(JSON.parse(line.slice(6))));
  }
  return concatBytes(encoded);
}

function encodeInvokeChunk(event: unknown): Uint8Array {
  const bytes = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
  return eventStreamCodec.encode({
    headers: {
      ":event-type": { type: "string", value: "chunk" },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: fromUtf8(JSON.stringify({ bytes })),
  });
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
