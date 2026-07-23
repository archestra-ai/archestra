/**
 * Ollama native (`/api/chat`) LLM-proxy adapter.
 *
 * Unlike `./ollama.ts` (the OpenAI-compatible `/v1` adapter), this talks Ollama's
 * first-class `/api/chat` wire on BOTH sides: the internal chat client
 * (`ollama-ai-provider-v2`) sends native requests, and we forward native requests
 * upstream and stream native NDJSON back. That native round-trip is what lets
 * Archestra send and display `num_ctx`, `num_predict`, `top_k`, `repeat_penalty`,
 * `think`, etc. — the sampling options Ollama's `/v1` endpoint silently discards.
 *
 * Because both sides are native there is NO wire translation: the adapter reads
 * native shapes for policy/logging/usage and re-emits native shapes. Streaming is
 * NDJSON (`application/x-ndjson`), one `ChatResponse`-shaped object per line, with
 * no `[DONE]` sentinel — the final `done: true` line ends the stream.
 */
import type {
  ArchestraInternalErrorCode,
  SupportedProvider,
} from "@archestra/shared";
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import logger from "@/logging";
import { ModelModel } from "@/models";
import { metrics } from "@/observability";
import { getTokenizer } from "@/tokenizers";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OllamaNative,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type NativeRequest = OllamaNative.Types.ChatRequest;
type NativeResponse = OllamaNative.Types.ChatResponse;
type NativeMessages = OllamaNative.Types.Messages;
type NativeMessage = OllamaNative.Types.Message;
type NativeHeaders = OllamaNative.Types.ChatHeaders;
type NativeStreamChunk = OllamaNative.Types.ChatStreamChunk;

const PROVIDER: SupportedProvider = "ollama-native";

/**
 * Prefix for the positional id synthesized when a tool result carries no
 * `tool_call_id` — the normal case on Ollama's native wire. Namespaced so it
 * can never collide with a caller-supplied id.
 */
const SYNTHETIC_TOOL_RESULT_ID_PREFIX = "ollama-native-tool-result-";

const NDJSON_HEADERS: Record<string, string> = {
  "Content-Type": "application/x-ndjson",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
};

/**
 * Token counts for fetch-based observability.
 *
 * Unlike every OpenAI-wire provider, Ollama's native `/api/chat` has no `usage`
 * object — the counts are top-level `prompt_eval_count` / `eval_count` fields,
 * and they are `omitempty` on the wire so they are absent (not zero) on
 * non-final chunks. Ollama reports no cache tokens at all.
 */
export function getUsageTokens(response: {
  prompt_eval_count?: number;
  eval_count?: number;
}) {
  return {
    input: response.prompt_eval_count ?? 0,
    output: response.eval_count ?? 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
}

/**
 * The upstream base URL is the Ollama root; strip any `/v1` suffix.
 *
 * Stripped against the parsed pathname, not the raw string: a base URL carrying
 * a query (`http://h:11434/v1?token=x`) does not end in `/v1`, so a plain
 * string replace left the suffix in place and every request 404'd on the
 * OpenAI-compatible path.
 */
function ollamaRoot(baseUrl: string | undefined): string {
  const raw = baseUrl ?? config.llm["ollama-native"].baseUrl ?? "";
  if (!raw) return "";

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not absolute — fall back to the string form rather than throwing.
    return raw.replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  return url.toString().replace(/\/+$/, "");
}

/** Native message `content` is a string on the wire; extract plain text. */
function nativeContentToText(content: NativeMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .join("");
  }
  return "";
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class OllamaNativeRequestAdapter
  implements LLMRequestAdapter<NativeRequest, NativeMessages>
{
  readonly provider = PROVIDER;
  private request: NativeRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: NativeRequest) {
    this.request = request;
  }

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    // `/api/chat` streams by DEFAULT — Ollama's `stream` is a `*bool` and a nil
    // pointer means true, which is why its own curl examples omit the field and
    // still get NDJSON. Only an explicit `false` turns streaming off.
    return this.request.stream !== false;
  }

  getMessages(): CommonMessage[] {
    return this.toCommonFormat(this.request.messages);
  }

  getToolResults(): CommonToolResult[] {
    const results: CommonToolResult[] = [];
    this.request.messages.forEach((message, index) => {
      if (message.role !== "tool") return;
      results.push({
        id: this.toolResultId(message, index),
        name:
          this.findToolNameInMessages(this.request.messages, message) ??
          "unknown",
        content: parseMaybeJson(nativeContentToText(message.content)),
        isError: false,
      });
    });
    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.tools) return [];
    return this.request.tools.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      inputSchema: (tool.function.parameters ?? {}) as Record<string, unknown>,
    }));
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): NativeMessages {
    return this.request.messages;
  }

  getOriginalRequest(): NativeRequest {
    return this.request;
  }

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.toolResultUpdates[toolCallId] = newContent;
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    Object.assign(this.toolResultUpdates, updates);
  }

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages, stats } = await convertNativeToolResultsToToon(
      this.request.messages,
      model,
    );
    this.request = { ...this.request, messages };
    return stats;
  }

  convertToolResultContent(messages: NativeMessages): NativeMessages {
    // Ollama tool results are plain strings by the time they reach the proxy
    // (ollama-ai-provider-v2 serializes structured tool output to a string), so
    // there are no MCP image blocks to convert here. Passthrough.
    return messages;
  }

  toProviderRequest(): NativeRequest {
    let messages = this.request.messages;
    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = messages.map((message, index) => {
        if (message.role !== "tool") return message;
        // Must use the same identity `toCommonFormat` handed to the guardrails,
        // or a sanitized result silently reverts to the untrusted original.
        const updated =
          this.toolResultUpdates[this.toolResultId(message, index)];
        return updated !== undefined
          ? { ...message, content: updated }
          : message;
      });
    }
    return { ...this.request, model: this.getModel(), messages };
  }

  /**
   * Stable identity for a tool-result message.
   *
   * Ollama's native wire has no id on either side — `tool_calls` carry no `id`
   * and tool results are correlated by `tool_name` — so `tool_call_id` is
   * present only when the caller is ollama-ai-provider-v2. Fall back to the
   * message's position, which is stable for the lifetime of one request:
   * `toCommonFormat`, `getToolResults` and `toProviderRequest` all index the
   * same array, and TOON compression rewrites content 1:1 without reordering.
   */
  private toolResultId(message: NativeMessage, index: number): string {
    return message.tool_call_id ?? `${SYNTHETIC_TOOL_RESULT_ID_PREFIX}${index}`;
  }

  private findToolNameInMessages(
    messages: NativeMessages,
    toolMessage: NativeMessage,
  ): string | null {
    const toolCallId = toolMessage.tool_call_id;
    if (toolCallId) {
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message.role === "assistant" && message.tool_calls) {
          for (const toolCall of message.tool_calls) {
            if (toolCall.id === toolCallId) {
              return toolCall.function.name;
            }
          }
        }
      }
    }
    // The native shape: results name the tool directly instead of referencing
    // a call id. Ollama's own clients send only this.
    return toolMessage.tool_name ?? null;
  }

  private toCommonFormat(messages: NativeMessages): CommonMessage[] {
    const out: CommonMessage[] = [];
    messages.forEach((message, index) => {
      const common: CommonMessage = {
        role: message.role as CommonMessage["role"],
        content: nativeContentToText(message.content),
      };
      // Every tool result must surface as a tool call, even when the name is
      // unresolvable. `evaluateIfContextIsTrusted` decides a context is trusted
      // purely from an empty tool-call list, so dropping one here disables
      // trusted-data policies and dual-LLM sanitization with no other signal.
      if (message.role === "tool") {
        common.toolCalls = [
          {
            id: this.toolResultId(message, index),
            name: this.findToolNameInMessages(messages, message) ?? "unknown",
            content: parseMaybeJson(nativeContentToText(message.content)),
            isError: false,
          },
        ];
      }
      out.push(common);
    });
    return out;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class OllamaNativeResponseAdapter
  implements LLMResponseAdapter<NativeResponse>
{
  readonly provider = PROVIDER;
  private response: NativeResponse;

  constructor(response: NativeResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.created_at ?? "";
  }

  getModel(): string {
    return this.response.model;
  }

  getText(): string {
    return this.response.message.content ?? "";
  }

  getToolCalls(): CommonToolCall[] {
    const toolCalls = this.response.message.tool_calls ?? [];
    return toolCalls.map((toolCall) => ({
      id: toolCall.id ?? "",
      name: toolCall.function.name,
      arguments: toToolArgsObject(toolCall.function.arguments),
    }));
  }

  hasToolCalls(): boolean {
    return (this.response.message.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.prompt_eval_count ?? 0,
      outputTokens: this.response.eval_count ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
  }

  getOriginalResponse(): NativeResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    if (this.hasToolCalls()) return ["tool_calls"];
    return [this.response.done_reason ?? "stop"];
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): NativeResponse {
    return {
      ...this.response,
      message: { role: "assistant", content: contentMessage },
      done: true,
      done_reason: "stop",
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class OllamaNativeStreamAdapter
  implements LLMStreamAdapter<NativeStreamChunk, NativeResponse>
{
  readonly provider = PROVIDER;
  readonly state: StreamAccumulatorState;
  /**
   * Seeded now, then overwritten by each upstream chunk. `created_at` is
   * REQUIRED by ollama-ai-provider-v2's stream schema, and the dual-LLM
   * progress callbacks emit lines through `formatTextDeltaSSE` before
   * `executeStream` has produced a chunk — leaving this undefined makes
   * `JSON.stringify` drop the key and the client fails the whole stream with
   * `finishReason: "error"` on the very first progress line.
   */
  private createdAt: string = new Date().toISOString();
  private thinking = "";
  // Raw native tool-call lines, buffered until policy approval then replayed.
  private rawToolCallLines: string[] = [];
  // Set to the refusal text when the response was replaced by a policy refusal.
  private replacedText: string | null = null;
  /** Ollama's own timing counters, read off the swallowed final chunk. */
  private upstreamMetrics: Record<string, number | undefined> = {};

  constructor() {
    this.state = {
      responseId: "",
      model: "",
      text: "",
      toolCalls: [],
      rawToolCallEvents: [],
      usage: null,
      stopReason: null,
      timing: { startTime: Date.now(), firstChunkTime: null },
    };
  }

  processChunk(chunk: NativeStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    this.state.model = chunk.model || this.state.model;
    this.createdAt = chunk.created_at ?? this.createdAt;
    if (!this.state.responseId) {
      this.state.responseId =
        chunk.created_at ?? `ollama-native-${chunk.model}`;
    }

    const message = chunk.message;
    const toolCalls = message?.tool_calls ?? [];

    // Capture usage + stop reason before any early return below. Current Ollama
    // sends tool calls and `done: true` on separate chunks, but nothing in the
    // wire format forbids one chunk carrying both — and if the tool-call branch
    // returned first, the interaction would persist with zero tokens and zero
    // cost, surfacing later as unexplained free requests.
    if (chunk.done) {
      this.state.stopReason = chunk.done_reason ?? "stop";
      this.state.usage = {
        inputTokens: chunk.prompt_eval_count ?? 0,
        outputTokens: chunk.eval_count ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      // The real final chunk is swallowed (formatEndSSE synthesizes its
      // replacement), so carry Ollama's own timings across or they never reach
      // the client. `ollama --verbose`, the n8n Ollama node and any tokens/sec
      // readout divide by `eval_duration`; dropping it yields NaN against
      // Archestra while the same request works direct to Ollama.
      this.upstreamMetrics = {
        total_duration: chunk.total_duration,
        load_duration: chunk.load_duration,
        prompt_eval_duration: chunk.prompt_eval_duration,
        eval_duration: chunk.eval_duration,
      };
    }

    // Accumulate assistant text/thinking before the tool-call branch returns: a
    // chunk carrying tool calls can also carry a preamble, and the client sees
    // that text (it rides inside the replayed raw line) while `state.text` is
    // what feeds the persisted interaction, the span and text evaluation. The
    // OpenAI adapter accumulates on tool-call chunks for the same reason.
    if (message?.thinking) {
      this.thinking += message.thinking;
    }
    if (message?.content) {
      this.state.text += message.content;
    }

    // Tool calls arrive whole (not incremental). Buffer them for policy eval.
    if (toolCalls.length > 0) {
      for (const toolCall of toolCalls) {
        this.state.toolCalls.push({
          id: toolCall.id ?? "",
          name: toolCall.function.name,
          arguments: JSON.stringify(
            toToolArgsObject(toolCall.function.arguments),
          ),
        });
      }
      // `done` is cleared on the buffered copy: formatEndSSE synthesizes the
      // terminating frame, so replaying a chunk that carried both tool calls
      // and `done: true` would emit a second one — ignored or a parse error
      // depending on the client. The stop reason and usage were already read
      // off the original above, and the counters are stripped here for the same
      // reason: formatEndSSE emits them on the synthesized frame, so leaving
      // them on the replayed line makes an accumulating client count twice.
      this.rawToolCallLines.push(
        ndjsonLine({
          ...chunk,
          done: false,
          done_reason: undefined,
          prompt_eval_count: undefined,
          eval_count: undefined,
          total_duration: undefined,
          load_duration: undefined,
          prompt_eval_duration: undefined,
          eval_duration: undefined,
        }),
      );
      return {
        sseData: null,
        isToolCallChunk: true,
        isFinal: chunk.done === true,
      };
    }

    // Final chunk: don't stream it — the synthesized `done: true` line is
    // emitted by formatEndSSE.
    if (chunk.done) {
      return { sseData: null, isToolCallChunk: false, isFinal: true };
    }

    // Text / thinking delta — stream immediately.
    const sseData =
      message?.content || message?.thinking ? ndjsonLine(chunk) : null;

    return { sseData, isToolCallChunk: false, isFinal: false };
  }

  getSSEHeaders(): Record<string, string> {
    return NDJSON_HEADERS;
  }

  formatTextDeltaSSE(text: string): string {
    return ndjsonLine({
      model: this.state.model,
      created_at: this.createdAt,
      message: { role: "assistant", content: text },
      done: false,
    });
  }

  getRawToolCallEvents(): string[] {
    return this.rawToolCallLines;
  }

  formatCompleteTextSSE(text: string): string[] {
    this.replacedText = text;
    return [
      ndjsonLine({
        model: this.state.model,
        created_at: this.createdAt,
        message: { role: "assistant", content: text },
        done: false,
      }),
    ];
  }

  formatEndSSE(): string {
    const doneReason = this.replacedText
      ? "stop"
      : (this.state.stopReason ?? "stop");
    const finalChunk: Record<string, unknown> = {
      model: this.state.model,
      created_at: this.createdAt,
      message: { role: "assistant", content: "" },
      done: true,
      done_reason: doneReason,
    };
    if (this.state.usage !== null) {
      finalChunk.prompt_eval_count = this.state.usage.inputTokens;
      finalChunk.eval_count = this.state.usage.outputTokens;
    }
    for (const [key, value] of Object.entries(this.upstreamMetrics)) {
      if (value !== undefined) finalChunk[key] = value;
    }
    return ndjsonLine(finalChunk);
  }

  toProviderResponse(): NativeResponse {
    const toolCalls =
      this.replacedText || this.state.toolCalls.length === 0
        ? undefined
        : this.state.toolCalls.map((tc) => ({
            id: tc.id,
            function: {
              name: tc.name,
              arguments: toToolArgsObject(tc.arguments),
            },
          }));

    return {
      model: this.state.model,
      created_at: this.createdAt,
      message: {
        role: "assistant",
        content: this.replacedText ?? this.state.text,
        ...(this.thinking ? { thinking: this.thinking } : {}),
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      done: true,
      done_reason: this.replacedText
        ? "stop"
        : (this.state.stopReason ?? "stop"),
      prompt_eval_count: this.state.usage?.inputTokens ?? 0,
      eval_count: this.state.usage?.outputTokens ?? 0,
    };
  }
}

// =============================================================================
// TOON COMPRESSION (native tool-result messages)
// =============================================================================

async function convertNativeToolResultsToToon(
  messages: NativeMessages,
  model: string,
): Promise<{ messages: NativeMessages; stats: ToolCompressionStats }> {
  const tokenizer = getTokenizer(PROVIDER);
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") {
      return message;
    }
    try {
      const unwrapped = unwrapToolContent(message.content);
      const parsed = JSON.parse(unwrapped);
      const compressed = toonEncode(parsed);
      const tokensBefore = tokenizer.countTokens([
        { role: "user", content: unwrapped },
      ]);
      const tokensAfter = tokenizer.countTokens([
        { role: "user", content: compressed },
      ]);
      toolResultCount++;
      totalTokensBefore += tokensBefore;
      if (tokensAfter < tokensBefore) {
        totalTokensAfter += tokensAfter;
        return { ...message, content: compressed };
      }
      totalTokensAfter += tokensBefore;
      return message;
    } catch {
      return message;
    }
  });

  let costSavings = 0;
  const tokensSaved = totalTokensBefore - totalTokensAfter;
  if (tokensSaved > 0) {
    costSavings = await ModelModel.calculateCostSavings(
      model,
      tokensSaved,
      PROVIDER,
    );
  }

  return {
    messages: result,
    stats: {
      tokensBefore: totalTokensBefore,
      tokensAfter: totalTokensAfter,
      costSavings,
      wasEffective: totalTokensAfter < totalTokensBefore,
      hadToolResults: toolResultCount > 0,
    },
  };
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

interface OllamaNativeClient {
  baseUrl: string;
  fetch: typeof fetch;
  headers: Record<string, string> | undefined;
  apiKey: string | undefined;
  abortSignal: AbortSignal | undefined;
}

export const ollamaNativeAdapterFactory: LLMProvider<
  NativeRequest,
  NativeResponse,
  NativeMessages,
  NativeStreamChunk,
  NativeHeaders
> = {
  provider: PROVIDER,
  interactionType: "ollama-native:chat",
  spanName: "chat",

  // This is the only NDJSON provider, so it is the only one that must override
  // the shared SSE error framing. An `event: error\ndata: …` frame appended to
  // an NDJSON stream is not a parseable line, so the client would surface a
  // parse failure instead of the upstream error that actually happened.
  formatStreamErrorFrame: (event) => ndjsonLine(event),

  createRequestAdapter(request) {
    return new OllamaNativeRequestAdapter(request);
  },

  createResponseAdapter(response) {
    return new OllamaNativeResponseAdapter(response);
  },

  createStreamAdapter() {
    return new OllamaNativeStreamAdapter();
  },

  extractApiKey(headers) {
    // The header schema already strips a leading "Bearer ".
    return headers.authorization;
  },

  getBaseUrl() {
    return config.llm["ollama-native"].baseUrl;
  },

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OllamaNativeClient {
    const observableFetch = options.agent
      ? metrics.llm.getObservableFetch(PROVIDER, options.agent, options.source)
      : fetch;
    return {
      baseUrl: ollamaRoot(options.baseUrl),
      fetch: observableFetch as typeof fetch,
      headers: options.defaultHeaders,
      apiKey,
      abortSignal: options.abortSignal,
    };
  },

  async execute(client, request): Promise<NativeResponse> {
    const c = client as OllamaNativeClient;
    const response = await c.fetch(chatUrl(c.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(c),
      body: JSON.stringify({ ...request, stream: false }),
      signal: c.abortSignal,
    });
    if (!response.ok) {
      throw await toUpstreamError(response);
    }
    return (await response.json()) as NativeResponse;
  },

  async executeStream(
    client,
    request,
  ): Promise<AsyncIterable<NativeStreamChunk>> {
    const c = client as OllamaNativeClient;
    const response = await c.fetch(chatUrl(c.baseUrl), {
      method: "POST",
      headers: buildUpstreamHeaders(c),
      body: JSON.stringify({ ...request, stream: true }),
      signal: c.abortSignal,
    });
    if (!response.ok) {
      throw await toUpstreamError(response);
    }
    if (!response.body) {
      // A 2xx with no body is still a failed turn. Reporting the upstream
      // status here would stamp `status: 200` on the error and surface it as
      // ApiError(200) — a success status on an error path.
      throw await toUpstreamError(response, 502);
    }
    return iterateNdjson(response.body);
  },

  extractInternalCode(): ArchestraInternalErrorCode | undefined {
    // Ollama silently truncates rather than raising a context-overflow error,
    // so there is no reliable structured signal to map. Sending `num_ctx` (issue
    // 1) is what makes the window authoritative.
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    const ollamaMessage = get(error, "error");
    if (typeof ollamaMessage === "string") return ollamaMessage;
    const nested = get(error, "error.message");
    if (typeof nested === "string") return nested;
    if (error instanceof Error) return error.message;
    return "Internal server error";
  },
};

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function buildUpstreamHeaders(
  client: OllamaNativeClient,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...(client.headers ?? {}),
    "Content-Type": "application/json",
  };
  if (client.apiKey) {
    headers.Authorization = `Bearer ${client.apiKey}`;
  }
  return headers;
}

/**
 * Upstream `/api/chat` URL, appended to whatever path prefix the base URL
 * carries.
 *
 * The endpoint is appended to `pathname` rather than resolved as a URL
 * reference. Resolving an absolute reference (`/api/chat`) would discard the
 * prefix, sending an Ollama published at `https://gw.example.com/ollama` — and
 * its bearer token — to `https://gw.example.com/api/chat`; resolving a relative
 * one leaves a base with a query string (`http://h/a/b?x=1`) dropping its last
 * segment. Query and fragment are meaningless for the upstream call, so they
 * are cleared instead of being allowed to relocate the path.
 */
function chatUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.search = "";
  url.hash = "";
  // `/v1` is the OpenAI-compatible endpoint; the native API is served from the
  // root. `createClient` already strips it, but a base URL can reach here
  // unnormalized, and appending `/api/chat` under `/v1` is always a 404.
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/chat`;
  return url.toString();
}

/**
 * Longest raw upstream body echoed back in an error message. A base URL
 * misconfigured to point at some other internal service would otherwise have
 * its entire response relayed to the caller.
 */
const MAX_UPSTREAM_ERROR_BODY_LENGTH = 500;

/**
 * Convert a non-OK upstream response into an error the shared proxy plumbing
 * understands. `status` is what `handleError` reads to pick the HTTP status —
 * without it every upstream failure collapses to a generic 500, so a caller
 * cannot tell Ollama's "model not found, try pulling it first" (404) from a
 * retryable 503, and Archestra's transient-error classification never engages.
 * `error.message` feeds `extractErrorMessage`.
 */
async function toUpstreamError(
  response: Response,
  /** Status to report instead of the upstream one, for failures the upstream
   * status does not describe (e.g. a 2xx that arrived with no body). */
  statusOverride?: number,
): Promise<Error> {
  const status = statusOverride ?? response.status;
  let message = `Ollama upstream returned HTTP ${status}`;
  try {
    const body = await response.text();
    if (body) {
      try {
        const parsed = JSON.parse(body);
        if (typeof parsed?.error === "string") message = parsed.error;
        else if (typeof parsed?.error?.message === "string")
          message = parsed.error.message;
        else message = truncateForError(body);
      } catch {
        message = truncateForError(body);
      }
    }
  } catch {
    // keep the default message
  }
  logger.debug(
    { status, upstreamStatus: response.status },
    "[OllamaNative] upstream error",
  );
  return Object.assign(new Error(message), {
    status,
    error: { message },
  });
}

function truncateForError(body: string): string {
  return body.length > MAX_UPSTREAM_ERROR_BODY_LENGTH
    ? `${body.slice(0, MAX_UPSTREAM_ERROR_BODY_LENGTH)}…`
    : body;
}

async function* iterateNdjson(
  body: ReadableStream<Uint8Array>,
): AsyncIterable<NativeStreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        const parsed = tryParseChunk(line);
        if (parsed) yield parsed;
      }
    }
    const tail = buffer.trim();
    if (tail) {
      const parsed = tryParseChunk(tail);
      if (parsed) yield parsed;
    }
  } finally {
    // Cancel, don't just release: the consumer breaks out of this generator as
    // soon as it sees the final chunk, and a throw mid-loop (a write to a
    // closed socket, a failed policy lookup) returns it too. Releasing alone
    // leaves the body neither drained nor aborted, holding the upstream
    // connection open while Ollama keeps generating.
    try {
      await reader.cancel();
    } catch (err) {
      logger.debug({ err }, "[OllamaNative] cancelling upstream body failed");
    }
    reader.releaseLock();
  }
}

function tryParseChunk(line: string): NativeStreamChunk | null {
  try {
    return JSON.parse(line) as NativeStreamChunk;
  } catch {
    logger.debug(
      { linePreview: line.slice(0, 120) },
      "[OllamaNative] skipping unparseable NDJSON line",
    );
    return null;
  }
}

function ndjsonLine(chunk: unknown): string {
  return `${JSON.stringify(chunk)}\n`;
}

function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Tool arguments as an object for policy evaluation.
 *
 * Arguments that do not parse into an object are preserved verbatim under
 * {@link UNPARSED_TOOL_ARGS_KEY} rather than collapsed to `{}`. The client
 * receives the original argument text inside the replayed raw line, so
 * discarding it here would let an argument-inspecting policy evaluate empty
 * arguments while the client executes the real ones.
 */
function toToolArgsObject(
  args: string | Record<string, unknown>,
): Record<string, unknown> {
  if (typeof args !== "string") return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // Length only, never the content: tool arguments routinely carry user data
    // and sometimes the secrets being handed to the tool. No sibling adapter
    // logs argument content at any level.
    logger.warn(
      { argsLength: args.length },
      "[OllamaNative] tool call arguments are not valid JSON; preserving raw text for policy evaluation",
    );
    return { [UNPARSED_TOOL_ARGS_KEY]: args };
  }
  // An array is `typeof "object"` but is not an argument object; casting it
  // would hand policy evaluation a shape it cannot read keys from.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  // Valid JSON, but a scalar or array rather than an argument object. Warn for
  // the same reason as the branch above — silently reshaping arguments is what
  // lets policy and client disagree.
  logger.warn(
    { argsLength: args.length, parsedType: typeof parsed },
    "[OllamaNative] tool call arguments are not a JSON object; preserving raw text for policy evaluation",
  );
  return { [UNPARSED_TOOL_ARGS_KEY]: args };
}

/** Key holding tool-call argument text that could not be read as an object. */
const UNPARSED_TOOL_ARGS_KEY = "__archestra_unparsed_arguments";
