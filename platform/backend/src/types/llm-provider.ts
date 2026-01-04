/**
 * LLM Proxy Common Types
 *
 * These types define adapter interfaces for working with provider-specific
 * requests and responses in a uniform way. The original provider data is
 * preserved and can be reconstructed after modifications.
 *
 * Usage flow:
 * ```
 * Provider Request
 *       ↓
 * RequestAdapter (wraps original, provides uniform read/modify API)
 *       ↓
 * [Business Logic operates via adapter methods]
 *       ↓
 * adapter.toProviderRequest() → Modified Provider Request
 *       ↓
 * LLM Provider
 *       ↓
 * Provider Response
 *       ↓
 * ResponseAdapter (wraps original, provides uniform read API)
 *       ↓
 * [Business Logic operates via adapter methods]
 *       ↓
 * adapter.toProviderResponse() or adapter.toRefusalResponse()
 * ```

 */

import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@shared";

import type {
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
} from "./common-llm-format";
import type { ToonCompressionResult } from "./tool-result-compression";

/**
 * Adapter interface for LLM requests
 *
 * Wraps provider-specific request and provides uniform API for business logic.
 * Original data is preserved and can be reconstructed after modifications.
 *
 * @typeParam TRequest - Provider-specific request type
 * @typeParam TMessages - Provider-specific messages type
 */
export interface LLMRequestAdapter<TRequest, TMessages = unknown> {
  /** Provider name */
  readonly provider: SupportedProvider;

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  /** Get model name */
  getModel(): string;

  /** Check if streaming is requested */
  isStreaming(): boolean;

  /** Get messages in common format (for trusted data evaluation) */
  getMessages(): CommonMessage[];

  /** Get tool results from messages (for trusted data evaluation) */
  getToolResults(): CommonToolResult[];

  /** Get tool definitions (for persistence, hasTools check) */
  getTools(): CommonMcpToolDefinition[];

  /** Check if request has tools */
  hasTools(): boolean;

  /** Get provider-specific messages (for token counting) */
  getProviderMessages(): TMessages;

  /** Get original unmodified request */
  getOriginalRequest(): TRequest;

  // ---------------------------------------------------------------------------
  // Modify Access
  // ---------------------------------------------------------------------------

  /** Set model (for cost optimization) */
  setModel(model: string): void;

  /**
   * Update a tool result's content (for trusted data updates, TOON compression)
   * @param toolCallId - The tool call ID to update
   * @param newContent - New content string
   */
  updateToolResult(toolCallId: string, newContent: string): void;

  /**
   * Apply multiple tool result updates at once
   * @param updates - Map of tool call ID to new content
   */
  applyToolResultUpdates(updates: Record<string, string>): void;

  /**
   * Apply TOON compression to tool results
   * @param model - Model name for token counting
   * @returns Compression statistics
   *
   * TODO: Refactor to remove TOON logic from adapter. Instead:
   * 1. Calculate TOON updates externally: calculateToonUpdates(adapter.getToolResults(), model) → { updates, stats }
   * 2. Apply via existing applyToolResultUpdates(updates)
   * This keeps adapters simple (just apply updates) and makes TOON logic provider-agnostic.
   */
  applyToonCompression(model: string): Promise<ToonCompressionResult>;

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  /**
   * Build the modified provider-specific request
   * Incorporates all modifications (model, tool results)
   */
  toProviderRequest(): TRequest;
}

// =============================================================================
// RESPONSE ADAPTER INTERFACE
// =============================================================================

/**
 * Adapter interface for LLM responses
 *
 * Wraps provider-specific response and provides uniform API for business logic.
 *
 * @typeParam TResponse - Provider-specific response type
 */
export interface LLMResponseAdapter<TResponse> {
  /** Provider name */
  readonly provider: SupportedProvider;

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  /** Get response ID */
  getId(): string;

  /** Get model name */
  getModel(): string;

  /** Get text content from response */
  getText(): string;

  /** Get tool calls from response (for tool invocation policies) */
  getToolCalls(): CommonToolCall[];

  /** Check if response has tool calls */
  hasToolCalls(): boolean;

  /** Get token usage */
  getUsage(): UsageView;

  /** Get original response */
  getOriginalResponse(): TResponse;

  // ---------------------------------------------------------------------------
  // Build Responses
  // ---------------------------------------------------------------------------

  /**
   * Build a refusal response (when tool invocation is blocked)
   * @param refusalMessage - Full message with metadata
   * @param contentMessage - Human-readable message
   */
  toRefusalResponse(refusalMessage: string, contentMessage: string): TResponse;
}

// =============================================================================
// STREAMING ADAPTER INTERFACE
// =============================================================================

/**
 * Accumulated state during streaming
 */
export interface StreamAccumulatorState {
  responseId: string;
  model: string;
  text: string;
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Raw tool call events stored for replay after policy approval */
  rawToolCallEvents: unknown[];
  usage: UsageView | null;
  stopReason: string | null;
  // timing for metrics
  timing: {
    startTime: number;
    firstChunkTime: number | null;
  };
}

/**
 * Result of processing a stream chunk
 */
export interface ChunkProcessingResult {
  /** SSE data to send to client immediately (null if should be held) */
  sseData: string | null;
  /** Whether this chunk contains tool call data (held for policy evaluation) */
  isToolCallChunk: boolean;
  /** Whether this is the final chunk */
  isFinal: boolean;
}

/**
 * Adapter interface for streaming LLM responses
 *
 * Handles parsing provider-specific chunks, accumulating state,
 * and formatting SSE events.
 *
 * @typeParam TChunk - Provider-specific stream chunk type
 * @typeParam TResponse - Provider-specific response type
 */
export interface LLMStreamAdapter<TChunk, TResponse> {
  /** Provider name */
  readonly provider: SupportedProvider;

  /** Current accumulated state */
  readonly state: StreamAccumulatorState;

  // ---------------------------------------------------------------------------
  // Chunk Processing
  // ---------------------------------------------------------------------------

  /**
   * processChunk process straming chunkgs one-by-one to:
   * 1. Tell LLMProxy how to handle current streaming chunk, depending on it's type (stream immediately, buffer for tool result inspection, etc.)
   * 2. Updates concrete StreamAdapter's internal StreamingAccumulatorState. This state is also used by the LLMProxy
   *    to build final response and other business logic.
   */
  processChunk(chunk: TChunk): ChunkProcessingResult;

  // ---------------------------------------------------------------------------
  // SSE Formatting
  // ---------------------------------------------------------------------------

  /** Format SSE headers for response */
  getSSEHeaders(): Record<string, string>;

  /**
   * Format a text fragment as SSE to inject into an ongoing stream.
   * Used for progress messages (e.g., dual LLM status) during streaming.
   */
  formatTextDeltaSSE(text: string): string;

  /** Get raw tool call events as SSE strings (for replay after policy approval) */
  getRawToolCallEvents(): string[];

  /**
   * Format a complete, self-contained text response as SSE events.
   * Used when replacing the response entirely (e.g., policy refusal).
   * Returns provider-specific events that form a valid complete response.
   */
  formatCompleteTextSSE(text: string): string[];

  /** Format the stream end marker */
  formatEndSSE(): string;

  // ---------------------------------------------------------------------------
  // Build Response
  // ---------------------------------------------------------------------------

  /**
   * Reconstructs a complete provider-native response from accumulated streaming chunks.
   *
   * During streaming, responses arrive as many small chunks (text deltas, tool call fragments, etc.).
   * This method combines all accumulated state into a single complete response object,
   * which is needed for saving the interaction to the database.
   */
  toProviderResponse(): TResponse;

  /**
   * Creates a provider-native response that replaces tool calls with a refusal message.
   *
   * When tool invocation policies block a tool call, we cannot return the original response
   * containing the blocked tool. Instead, we return a valid response with the same metadata
   * (id, model, usage) but with content replaced by a text message explaining the refusal.
   *
   * @param refusalMessage - Full message with metadata (for logging)
   * @param contentMessage - Human-readable message (sent to client)
   */
  toProviderRefusalResponse(
    refusalMessage: string,
    contentMessage: string,
  ): TResponse;
}

// =============================================================================
// ADAPTER FACTORY INTERFACE
// =============================================================================

/**
 * Factory for creating adapters for a specific provider
 *
 * Each provider implements this interface to create adapters for their
 * request/response types.
 *
 * @typeParam TRequest - Provider-specific request type
 * @typeParam TResponse - Provider-specific response type
 * @typeParam TMessages - Provider-specific messages type
 * @typeParam TChunk - Provider-specific stream chunk type
 * @typeParam THeaders - Provider-specific headers type
 */
export interface LLMProvider<TRequest, TResponse, TMessages, TChunk, THeaders> {
  /** Provider name */
  readonly provider: SupportedProvider;

  /** Interaction type for database storage */
  readonly interactionType: SupportedProviderDiscriminator;

  // ---------------------------------------------------------------------------
  // Adapter Creation
  // ---------------------------------------------------------------------------

  /** Create a request adapter */
  createRequestAdapter(
    request: TRequest,
  ): LLMRequestAdapter<TRequest, TMessages>;

  /** Create a response adapter */
  createResponseAdapter(response: TResponse): LLMResponseAdapter<TResponse>;

  /** Create a stream adapter */
  createStreamAdapter(): LLMStreamAdapter<TChunk, TResponse>;

  // ---------------------------------------------------------------------------
  // Client & Headers
  // ---------------------------------------------------------------------------

  /** Extract API key from headers */
  extractApiKey(headers: THeaders): string | undefined;

  /** Get base URL for the provider (from config), undefined means use SDK default */
  getBaseUrl(): string | undefined;

  /** Get span name for tracing (e.g., "openai.chat.completions", "anthropic.messages") */
  getSpanName(streaming: boolean): string;

  /** Create provider client */
  createClient(
    apiKey: string | undefined,
    options?: { baseUrl?: string; fetch?: typeof fetch; mockMode?: boolean },
  ): unknown;

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /** Execute non-streaming request */
  execute(client: unknown, request: TRequest): Promise<TResponse>;

  /** Execute streaming request */
  executeStream(
    client: unknown,
    request: TRequest,
  ): Promise<AsyncIterable<TChunk>>;

  /**
   * Extract error message from provider-specific SDK error.
   * Each provider SDK wraps errors differently (e.g., Anthropic uses nested
   * error.error.message structure), so this normalizes them to a string.
   */
  extractErrorMessage(error: unknown): string;
}

/**
 * Token usage from response
 */
export interface UsageView {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Create initial stream accumulator state
 */
export function createStreamAccumulatorState(): StreamAccumulatorState {
  return {
    responseId: "",
    model: "",
    text: "",
    toolCalls: [],
    rawToolCallEvents: [],
    usage: null,
    stopReason: null,
    timing: {
      startTime: Date.now(),
      firstChunkTime: null,
    },
  };
}
