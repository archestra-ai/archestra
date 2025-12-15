/**
 * LLM Proxy Common Types
 *
 * These types define accessor interfaces for working with provider-specific
 * requests and responses in a uniform way. The original provider data is
 * preserved and can be reconstructed after modifications.
 *
 * ## Architecture
 *
 * ```
 * Provider Request
 *       ↓
 * RequestAccessor (wraps original, provides uniform read/modify API)
 *       ↓
 * [Business Logic operates via accessor methods]
 * - Trusted data policies: accessor.getToolResults(), accessor.updateToolResult()
 * - Cost optimization: accessor.getModel(), accessor.setModel()
 * - TOON compression: accessor.updateToolResult()
 *       ↓
 * accessor.toProviderRequest() → Modified Provider Request
 *       ↓
 * LLM Provider
 *       ↓
 * Provider Response
 *       ↓
 * ResponseAccessor (wraps original, provides uniform read API)
 *       ↓
 * [Business Logic operates via accessor methods]
 * - Tool invocation policies: accessor.getToolCalls()
 * - Metrics: accessor.getUsage()
 *       ↓
 * accessor.toProviderResponse() or accessor.toRefusalResponse()
 * ```
 *
 * ## Why Accessor Pattern?
 *
 * Provider schemas are fundamentally different (not just field names):
 * - Anthropic: flat content[] with type discriminators
 * - OpenAI: choices[] with nested message, separate tool role
 * - Gemini: candidates[] with content.parts[]
 *
 * A unified data structure would either lose data or be extremely complex.
 * Accessors preserve original data while providing uniform business logic API.
 */

import type { SupportedProvider } from "./llm-providers";

// =============================================================================
// EXISTING TYPES (re-exported for business logic use)
// =============================================================================

// These minimal types are used by business logic (trusted data, tool invocation)
export type { CommonMessage, ToolResultUpdates } from "./llm-proxy";
export type {
  CommonToolCall,
  CommonToolResult,
  CommonMcpToolDefinition,
} from "./tool-execution";

// =============================================================================
// COMMON VIEW TYPES (for business logic)
// =============================================================================

/**
 * Tool definition as seen by business logic
 */
export interface ToolDefinitionView {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

/**
 * Tool result in a message (for trusted data evaluation)
 */
export interface ToolResultView {
  /** Tool call ID (to match with tool_use) */
  id: string;
  /** Tool name */
  name: string;
  /** Result content (parsed if JSON, otherwise string) */
  content: unknown;
  /** Whether this was an error result */
  isError: boolean;
}

/**
 * Tool call from LLM response (for tool invocation policies)
 */
export interface ToolCallView {
  /** Tool call ID */
  id: string;
  /** Tool name */
  name: string;
  /** Arguments (parsed object or raw string) */
  arguments: Record<string, unknown> | string;
}

/**
 * Token usage from response
 */
export interface UsageView {
  inputTokens: number;
  outputTokens: number;
}

/**
 * Why model stopped generating
 */
export type StopReasonView =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "error"
  | "unknown";

// =============================================================================
// REQUEST ACCESSOR INTERFACE
// =============================================================================

/**
 * Accessor interface for LLM requests
 *
 * Wraps provider-specific request and provides uniform API for business logic.
 * Original data is preserved and can be reconstructed after modifications.
 *
 * @typeParam TRequest - Provider-specific request type
 * @typeParam TMessages - Provider-specific messages type
 */
export interface LLMRequestAccessor<TRequest, TMessages = unknown> {
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
  getMessagesForPolicyEvaluation(): import("./llm-proxy").CommonMessage[];

  /** Get tool results from messages (for trusted data evaluation) */
  getToolResults(): ToolResultView[];

  /** Get tool definitions (for persistence, hasTools check) */
  getTools(): ToolDefinitionView[];

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
// RESPONSE ACCESSOR INTERFACE
// =============================================================================

/**
 * Accessor interface for LLM responses
 *
 * Wraps provider-specific response and provides uniform API for business logic.
 *
 * @typeParam TResponse - Provider-specific response type
 */
export interface LLMResponseAccessor<TResponse> {
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
  getToolCalls(): ToolCallView[];

  /** Check if response has tool calls */
  hasToolCalls(): boolean;

  /** Get token usage */
  getUsage(): UsageView;

  /** Get stop reason */
  getStopReason(): StopReasonView;

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
// STREAMING ACCESSOR INTERFACE
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
  usage: UsageView | null;
  stopReason: StopReasonView | null;
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
 * Accessor interface for streaming LLM responses
 *
 * Handles parsing provider-specific chunks, accumulating state,
 * and formatting SSE events.
 *
 * @typeParam TChunk - Provider-specific stream chunk type
 * @typeParam TResponse - Provider-specific response type
 */
export interface LLMStreamAccessor<TChunk, TResponse> {
  /** Provider name */
  readonly provider: SupportedProvider;

  /** Current accumulated state */
  readonly state: StreamAccumulatorState;

  // ---------------------------------------------------------------------------
  // Chunk Processing
  // ---------------------------------------------------------------------------

  /**
   * Process a stream chunk
   * Updates internal state and returns SSE data if should be sent immediately
   * Tool call chunks are accumulated but not sent (for policy evaluation)
   */
  processChunk(chunk: TChunk): ChunkProcessingResult;

  // ---------------------------------------------------------------------------
  // SSE Formatting
  // ---------------------------------------------------------------------------

  /** Format SSE headers for response */
  getSSEHeaders(): Record<string, string>;

  /** Format accumulated tool calls as SSE events (after policy approval) */
  formatToolCallsSSE(): string[];

  /** Format a refusal as SSE events */
  formatRefusalSSE(refusalMessage: string, contentMessage: string): string[];

  /** Format the stream end marker */
  formatEndSSE(): string;

  // ---------------------------------------------------------------------------
  // Build Response
  // ---------------------------------------------------------------------------

  /** Build a response accessor from accumulated state */
  toResponseAccessor(): LLMResponseAccessor<TResponse>;

  /** Build provider response from accumulated state */
  toProviderResponse(): TResponse;

  /** Build provider refusal response */
  toProviderRefusalResponse(
    refusalMessage: string,
    contentMessage: string,
  ): TResponse;
}

// =============================================================================
// ADAPTER FACTORY INTERFACE
// =============================================================================

/**
 * Factory for creating accessors for a specific provider
 *
 * Each provider implements this interface to create accessors for their
 * request/response types.
 *
 * @typeParam TRequest - Provider-specific request type
 * @typeParam TResponse - Provider-specific response type
 * @typeParam TMessages - Provider-specific messages type
 * @typeParam TChunk - Provider-specific stream chunk type
 * @typeParam THeaders - Provider-specific headers type
 */
export interface LLMProviderAdapterFactory<
  TRequest,
  TResponse,
  TMessages,
  TChunk,
  THeaders,
> {
  /** Provider name */
  readonly provider: SupportedProvider;

  /** Interaction type for database storage */
  readonly interactionType:
    | "openai:chatCompletions"
    | "gemini:generateContent"
    | "anthropic:messages";

  // ---------------------------------------------------------------------------
  // Accessor Creation
  // ---------------------------------------------------------------------------

  /** Create a request accessor */
  createRequestAccessor(request: TRequest): LLMRequestAccessor<TRequest, TMessages>;

  /** Create a response accessor */
  createResponseAccessor(response: TResponse): LLMResponseAccessor<TResponse>;

  /** Create a stream accessor */
  createStreamAccessor(model: string): LLMStreamAccessor<TChunk, TResponse>;

  // ---------------------------------------------------------------------------
  // Client & Headers
  // ---------------------------------------------------------------------------

  /** Extract API key from headers */
  extractApiKey(headers: THeaders): string | undefined;

  /** Create provider client */
  createClient(
    apiKey: string | undefined,
    options?: { baseUrl?: string; fetch?: typeof fetch },
  ): unknown;

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  /** Execute non-streaming request */
  execute(client: unknown, request: TRequest): Promise<TResponse>;

  /** Execute streaming request */
  executeStream(client: unknown, request: TRequest): Promise<AsyncIterable<TChunk>>;
}

// =============================================================================
// PROCESSING CONTEXT
// =============================================================================

/**
 * Context for request processing pipeline
 */
export interface ProxyContext {
  /** Provider name */
  provider: SupportedProvider;

  /** Resolved profile/agent */
  profileId: string;
  profileName: string;

  /** External agent ID from X-Archestra-Agent-Id header */
  externalAgentId?: string;

  /** Whether profile has considerContextUntrusted enabled */
  considerContextUntrusted: boolean;

  /** API key for the provider */
  apiKey?: string;

  /** Profile labels (for metrics) */
  labels?: Array<{ key: string; value: string }>;
}

// =============================================================================
// RESULT TYPES
// =============================================================================

/**
 * Result of cost optimization
 */
export interface CostOptimizationResult {
  baselineModel: string;
  optimizedModel: string;
  wasOptimized: boolean;
}

/**
 * Result of TOON compression
 */
export interface ToonCompressionResult {
  tokensBefore: number | null;
  tokensAfter: number | null;
  costSavings: number | null;
}

/**
 * Result of trusted data evaluation
 */
export interface TrustedDataResult {
  /** Map of tool call IDs to updated content */
  toolResultUpdates: Record<string, string>;
  /** Whether context is trusted */
  contextIsTrusted: boolean;
  /** Whether dual LLM was used */
  usedDualLlm: boolean;
}

/**
 * Tool invocation policy refusal
 */
export interface ToolRefusal {
  toolName: string;
  toolArguments: Record<string, unknown>;
  reason: string;
  /** Full message with archestra metadata */
  refusalMessage: string;
  /** Human-readable message */
  contentMessage: string;
}

// =============================================================================
// INTERACTION DATA
// =============================================================================

/**
 * Data for recording an interaction
 */
export interface InteractionData {
  profileId: string;
  externalAgentId?: string;
  type: "openai:chatCompletions" | "gemini:generateContent" | "anthropic:messages";
  model: string;

  inputTokens: number | null;
  outputTokens: number | null;

  baselineCost: number | null;
  cost: number | null;

  toonTokensBefore: number | null;
  toonTokensAfter: number | null;
  toonCostSavings: number | null;

  /** Original provider request */
  request: unknown;
  /** Modified provider request (after policies, TOON) */
  processedRequest: unknown;
  /** Provider response */
  response: unknown;
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build tool refusal message
 */
export function buildToolRefusal(
  toolName: string,
  toolArguments: Record<string, unknown>,
  reason: string,
): ToolRefusal {
  const metadata = `
<archestra-tool-name>${toolName}</archestra-tool-name>
<archestra-tool-arguments>${JSON.stringify(toolArguments)}</archestra-tool-arguments>
<archestra-tool-reason>${reason}</archestra-tool-reason>`;

  const contentMessage = `
I tried to invoke the ${toolName} tool with the following arguments: ${JSON.stringify(toolArguments)}.

However, I was denied by a tool invocation policy:

${reason}`;

  return {
    toolName,
    toolArguments,
    reason,
    refusalMessage: `${metadata}\n${contentMessage}`,
    contentMessage,
  };
}

/**
 * Convert ToolCallView[] to format expected by tool invocation policies
 */
export function toolCallsForPolicyEvaluation(
  toolCalls: ToolCallView[],
): Array<{ toolCallName: string; toolCallArgs: string }> {
  return toolCalls.map((tc) => ({
    toolCallName: tc.name,
    toolCallArgs:
      typeof tc.arguments === "string"
        ? tc.arguments
        : JSON.stringify(tc.arguments),
  }));
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
    usage: null,
    stopReason: null,
    timing: {
      startTime: Date.now(),
      firstChunkTime: null,
    },
  };
}
