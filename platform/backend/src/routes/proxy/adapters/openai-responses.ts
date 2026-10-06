import { randomUUID } from "node:crypto";
import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  CompactedResponse,
  ResponseCompactParams,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseInput,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import {
  wrapCompactionItem,
  wrapCompactionResponse,
} from "@/openappa/compaction-carrier";
import {
  decodeOpenAiCodexCredential,
  isOpenAiCodexCredential,
} from "@/services/openai-codex-credentials";
import type {
  ChunkProcessingResult,
  CommonCustomToolCall,
  CommonFunctionToolCall,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  CreateClientOptions,
  HostedToolCall,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenAi,
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import {
  ApiError,
  createStreamAccumulatorState,
  extractCommonToolCallArguments,
} from "@/types";
import {
  createOpenAiCodexPassthroughResponsesClient,
  createOpenAiCodexResponsesClient,
} from "./openai-codex-responses-client";
import { formatResponsesStreamErrorFrame } from "./responses-stream-error-frame";
import {
  customToolInput,
  firstHostedOutputIndex,
  formatResponsesFunctionCallFrames,
  holdResponsesHostedOutput,
  namespaceOf,
  namespacesByCallId,
  prependPrefixToResponse,
  responsesHostedToolCalls,
  rewriteResponsesOutput,
  toSse,
} from "./responses-tool-call-rewrite";
import { fromResponsesUsage, toResponsesUsage } from "./responses-usage";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";
import { subscriptionAuthRequiredCode } from "./subscription-auth-error";

type OpenAiResponsesRequest = OpenAi.Types.ResponsesRequest;
type OpenAiResponsesResponse = OpenAi.Types.ResponsesResponse;
type OpenAiResponsesHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiResponsesStreamChunk = OpenAi.Types.ResponseChunk;
type OpenAiResponseInput = string | ResponseInput | undefined;
type OpenAiCompactRequest = Omit<ResponseCompactParams, "model" | "input"> & {
  model: string;
  input?: string | ResponseInput;
};

type OpenAiFunctionToolDefinition = {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
};

export class ResponsesStreamIncompleteError extends Error {
  readonly code = "proxy_stream_incomplete";
  readonly status = 502;

  constructor() {
    super(
      "Proxy detected an OpenAI Responses stream ending without a terminal event",
    );
    this.name = "ResponsesStreamIncompleteError";
  }
}

export const openAiResponsesAdapterFactory: LLMProvider<
  OpenAiResponsesRequest,
  OpenAiResponsesResponse,
  OpenAiResponseInput,
  OpenAiResponsesStreamChunk,
  OpenAiResponsesHeaders
> = {
  provider: "openai",
  interactionType: "openai:responses",

  // The Responses parser drops a chat-completions-shaped error frame as an
  // unknown chunk, turning an upstream failure into a blank turn.
  formatStreamErrorFrame: formatResponsesStreamErrorFrame,

  createRequestAdapter(
    request: OpenAiResponsesRequest,
  ): LLMRequestAdapter<OpenAiResponsesRequest, OpenAiResponseInput> {
    return new OpenAiResponsesRequestAdapter(request);
  },

  createResponseAdapter(
    response: OpenAiResponsesResponse,
    request?: OpenAiResponsesRequest,
  ): LLMResponseAdapter<OpenAiResponsesResponse> {
    const namespaces = uniqueDeclaredNamespaces(request);
    return new OpenAiResponsesResponseAdapter({
      ...response,
      output: response.output?.map((item) =>
        stampDeclaredNamespace(item, namespaces),
      ),
    });
  },

  createStreamAdapter(
    request?: OpenAiResponsesRequest,
  ): LLMStreamAdapter<OpenAiResponsesStreamChunk, OpenAiResponsesResponse> {
    return new OpenAiResponsesStreamAdapter(uniqueDeclaredNamespaces(request));
  },

  extractApiKey(headers: OpenAiResponsesHeaders): string | undefined {
    return headers.authorization;
  },

  isSubscriptionCredential(apiKey: string | undefined): boolean {
    // ChatGPT-subscription (Codex) credentials travel through the proxy as
    // marker-prefixed encoded strings (`chatgpt-oauth:…`). They are covered by
    // a flat-rate plan, so they must classify as subscription — the same rule
    // as Anthropic `sk-ant-oat…` OAuth tokens. `extractApiKey` returns the
    // authorization header as-is, so strip an optional `Bearer ` prefix before
    // the format check; plain `sk-…` API keys stay metered.
    const token = apiKey?.startsWith("Bearer ") ? apiKey.slice(7) : apiKey;
    return isOpenAiCodexCredential(token);
  },

  getBaseUrl(): string | undefined {
    return config.llm.openai.baseUrl || undefined;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    if (!apiKey) {
      throw new ApiError(401, "API key required for OpenAI");
    }

    // OpenCode owns refresh/rotation for this request's OAuth access token. The
    // bridge client only forwards the request-local material to Codex; it never
    // persists or refreshes it.
    if (options.openAiCodexPassthrough) {
      return createOpenAiCodexPassthroughResponsesClient({
        credential: options.openAiCodexPassthrough,
        options,
      });
    }

    // A ChatGPT-subscription (Codex) credential routes to the ChatGPT Codex
    // Responses backend (chatgpt.com), never to api.openai.com. The Codex
    // backend is itself a Responses API, so the request is forwarded with the
    // OAuth identity headers + mandatory transforms and its event stream is
    // returned unchanged. This is the endpoint the OpenAI Codex CLI targets.
    const codexCredential = decodeOpenAiCodexCredential(apiKey);
    if (codexCredential) {
      return createOpenAiCodexResponsesClient({
        credential: codexCredential,
        options,
      });
    }

    const resolvedBaseUrl = options.baseUrl || config.llm.openai.baseUrl;

    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("openai", options.agent, options.source)
      : undefined;

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey,
      baseURL: resolvedBaseUrl,
      fetch: customFetch,
      defaultHeaders: options.defaultHeaders,
    });
  },

  async execute(
    client: unknown,
    request: OpenAiResponsesRequest,
  ): Promise<OpenAiResponsesResponse> {
    const openaiClient = client as OpenAIProvider;

    return (await openaiClient.responses.create(
      request as ResponseCreateParamsNonStreaming,
    )) as unknown as OpenAiResponsesResponse;
  },

  async executeStream(
    client: unknown,
    request: OpenAiResponsesRequest,
  ): Promise<AsyncIterable<OpenAiResponsesStreamChunk>> {
    const openaiClient = client as OpenAIProvider;

    const stream = (await openaiClient.responses.create({
      ...request,
      stream: true,
    } as ResponseCreateParamsStreaming)) as AsyncIterable<OpenAiResponsesStreamChunk>;
    // Spread-factory aliases keep their own transport contracts. Native compact
    // requests have a separate executeStream implementation below.
    if (
      this.provider !== "openai" ||
      this.interactionType !== "openai:responses"
    ) {
      return stream;
    }
    return {
      async *[Symbol.asyncIterator]() {
        let terminalSeen = false;
        for await (const chunk of stream) {
          if (
            chunk.type === "response.completed" ||
            chunk.type === "response.failed" ||
            chunk.type === "response.incomplete"
          ) {
            terminalSeen = true;
          }
          yield chunk;
        }
        if (!terminalSeen) throw new ResponsesStreamIncompleteError();
      },
    };
  },

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    if (get(error, "error.code") === "context_length_exceeded") {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return subscriptionAuthRequiredCode(error);
  },

  extractErrorMessage(error: unknown): string {
    return (
      get(error, "error.message") ??
      get(error, "message") ??
      "Internal server error"
    );
  },
};

export const openAiResponsesCompactAdapterFactory: LLMProvider<
  OpenAiCompactRequest,
  CompactedResponse,
  OpenAiResponseInput,
  never,
  OpenAiResponsesHeaders
> = {
  ...openAiResponsesAdapterFactory,

  createRequestAdapter(
    request: OpenAiCompactRequest,
  ): LLMRequestAdapter<OpenAiCompactRequest, OpenAiResponseInput> {
    return new OpenAiResponsesCompactRequestAdapter(request);
  },

  createResponseAdapter(
    response: CompactedResponse,
  ): LLMResponseAdapter<CompactedResponse> {
    return new OpenAiResponsesCompactResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<never, CompactedResponse> {
    return new OpenAiResponsesStreamAdapter() as unknown as LLMStreamAdapter<
      never,
      CompactedResponse
    >;
  },

  async execute(
    client: unknown,
    request: OpenAiCompactRequest,
  ): Promise<CompactedResponse> {
    const openaiClient = client as OpenAIProvider;
    return await openaiClient.responses.compact(
      toCompactRequest(request) as ResponseCompactParams,
    );
  },

  async executeStream(): Promise<AsyncIterable<never>> {
    throw new ApiError(400, "OpenAI compaction does not support streaming");
  },
};

class OpenAiResponsesRequestAdapter
  implements LLMRequestAdapter<OpenAiResponsesRequest, OpenAiResponseInput>
{
  readonly provider = "openai" as const;
  private request: OpenAiResponsesRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: OpenAiResponsesRequest) {
    this.request = request;
  }

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return this.request.stream === true;
  }

  getMessages(): CommonMessage[] {
    if (typeof this.request.input === "string") {
      return [{ role: "user", content: this.request.input }];
    }

    if (!Array.isArray(this.request.input)) {
      return [];
    }

    // Pair function_call_output items with their function_call by call_id so
    // tool results surface as CommonMessage.toolCalls — the shape trusted-data
    // / Dual LLM policy evaluation reads. Without the pairing, Responses-routed
    // conversations look tool-free to the evaluator and sanitization is
    // silently bypassed.
    const toolCallsByCallId = getToolCallsByCallId(this.request.input);

    return this.request.input.flatMap((item) =>
      toCommonMessages(item, toolCallsByCallId),
    );
  }

  getToolResults(): CommonToolResult[] {
    if (!Array.isArray(this.request.input)) {
      return [];
    }

    const toolCallsByCallId = getToolCallsByCallId(this.request.input);

    return this.request.input.flatMap((item) => {
      if (!isFunctionCallOutputItem(item)) {
        return [];
      }

      const toolCall = toolCallsByCallId.get(item.call_id);
      return [
        {
          id: item.call_id,
          name: toolCall?.name ?? "unknown",
          ...(toolCall?.namespace ? { namespace: toolCall.namespace } : {}),
          arguments: toolCall?.arguments,
          content: item.output,
          // Compatible clients may extend tool outputs with a boolean status;
          // native Responses has no is_error field. Do not infer it from output.
          isError: "is_error" in item && item.is_error === true,
        },
      ];
    });
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!Array.isArray(this.request.tools)) {
      return [];
    }

    return this.request.tools.flatMap((tool) => {
      if (!isFunctionToolDefinition(tool)) {
        return [];
      }

      return [
        {
          name: tool.name,
          description: tool.description ?? undefined,
          inputSchema: tool.parameters ?? {},
        },
      ];
    });
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): OpenAiResponseInput {
    return this.request.input;
  }

  getOriginalRequest(): OpenAiResponsesRequest {
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

  convertToolResultContent(input: OpenAiResponseInput): OpenAiResponseInput {
    // OpenAI Responses accepts tool results in their native function_call_output
    // shape, so the proxy should pass them through unchanged.
    return input;
  }

  toProviderRequest(): OpenAiResponsesRequest {
    if (!Array.isArray(this.request.input)) {
      return {
        ...this.request,
        model: this.getModel(),
      };
    }

    return {
      ...this.request,
      model: this.getModel(),
      input: this.request.input.map((item) => {
        if (!isFunctionCallOutputItem(item)) {
          return item;
        }

        // Presence, not truthiness: a sanitizer that reduces sensitive output
        // to nothing has replaced it, and forwarding the original instead would
        // hand the model exactly what was withheld.
        const updatedOutput = this.toolResultUpdates[item.call_id];
        if (updatedOutput === undefined) {
          return item;
        }

        return {
          ...item,
          output: updatedOutput,
        };
      }) as unknown as ResponseInput,
    };
  }
}

class OpenAiResponsesCompactRequestAdapter
  implements LLMRequestAdapter<OpenAiCompactRequest, OpenAiResponseInput>
{
  readonly provider = "openai" as const;
  private readonly delegate: OpenAiResponsesRequestAdapter;

  constructor(private readonly request: OpenAiCompactRequest) {
    this.delegate = new OpenAiResponsesRequestAdapter(
      request as OpenAiResponsesRequest,
    );
  }

  getModel(): string {
    return this.delegate.getModel();
  }

  isStreaming(): boolean {
    return false;
  }

  getMessages(): CommonMessage[] {
    return this.delegate.getMessages();
  }

  getToolResults(): CommonToolResult[] {
    return this.delegate.getToolResults();
  }

  getTools(): CommonMcpToolDefinition[] {
    return [];
  }

  hasTools(): boolean {
    return false;
  }

  getProviderMessages(): OpenAiResponseInput {
    return this.delegate.getProviderMessages();
  }

  getOriginalRequest(): OpenAiCompactRequest {
    return this.request;
  }

  setModel(model: string): void {
    this.delegate.setModel(model);
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.delegate.updateToolResult(toolCallId, newContent);
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    this.delegate.applyToolResultUpdates(updates);
  }

  convertToolResultContent(input: OpenAiResponseInput): OpenAiResponseInput {
    return this.delegate.convertToolResultContent(input);
  }

  toProviderRequest(): OpenAiCompactRequest {
    return toCompactRequest(
      this.delegate.toProviderRequest() as OpenAiCompactRequest,
    );
  }
}

class OpenAiResponsesResponseAdapter
  implements LLMResponseAdapter<OpenAiResponsesResponse>
{
  readonly provider = "openai" as const;
  private response: OpenAiResponsesResponse;

  constructor(response: OpenAiResponsesResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    return this.response.model;
  }

  getText(): string {
    return this.response.output
      .flatMap((item) => {
        if (!isResponseMessage(item)) {
          return [];
        }

        return item.content.flatMap((contentPart) => {
          if (contentPart.type === "output_text") {
            return [contentPart.text];
          }

          if (contentPart.type === "refusal") {
            return [contentPart.refusal];
          }

          return [];
        });
      })
      .join("\n");
  }

  getToolCalls(): CommonToolCall[] {
    return this.response.output.flatMap<CommonToolCall>((item) => {
      // A custom tool is called with free-form text rather than JSON arguments
      // — Codex's `apply_patch` is one. It is still a call this proxy releases
      // or refuses, so it is carried as the one argument it has.
      if (isResponseCustomToolCall(item)) {
        const call: CommonCustomToolCall = {
          id: item.call_id,
          name: item.name,
          arguments: { input: item.input },
          kind: "custom",
          ...namespaceOf(item),
        };
        return [call];
      }
      if (!isResponseFunctionCall(item)) {
        return [];
      }

      const call: CommonFunctionToolCall = {
        id: item.call_id,
        name: item.name,
        arguments: tryParseJsonObject(item.arguments),
        kind: "function",
        ...namespaceOf(item),
      };
      return [call];
    });
  }

  hasToolCalls(): boolean {
    return this.getToolCalls().length > 0;
  }

  getUsage(): UsageView {
    return fromResponsesUsage(this.response.usage);
  }

  getOriginalResponse(): OpenAiResponsesResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    if (
      this.response.status === "failed" ||
      this.response.status === "incomplete"
    ) {
      return [this.response.status];
    }
    if (this.hasToolCalls()) {
      return ["tool_calls"];
    }

    return [this.response.status ?? "completed"];
  }

  withRewrittenToolCalls(
    toolCalls: Array<{
      id: string;
      name: string;
      arguments: string;
      wireId?: string;
    }>,
  ): OpenAiResponsesResponse {
    return {
      ...this.response,
      output: rewriteResponsesOutput(
        withoutOmittedToolCalls(this.response.output, toolCalls),
        toolCalls,
      ),
    } as unknown as OpenAiResponsesResponse;
  }

  getHostedToolCalls(): HostedToolCall[] {
    return responsesHostedToolCalls(this.response.output);
  }

  withHeldHostedToolCalls(
    notices: Array<{
      id: string;
      name: string;
      arguments: string;
      namespace?: string;
      wireId?: string;
    }>,
  ): OpenAiResponsesResponse {
    const output = holdResponsesHostedOutput(this.response.output, notices);
    return {
      ...this.response,
      output,
      ...("output_text" in this.response
        ? {
            output_text: responseOutputText(
              output as OpenAiResponsesResponse["output"],
            ),
          }
        : {}),
    } as unknown as OpenAiResponsesResponse;
  }

  toRefusalResponse(
    refusalMessage: string,
    contentMessage: string,
  ): OpenAiResponsesResponse {
    return {
      id: this.response.id,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.response.model,
      status: "completed",
      output: [
        {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "refusal",
              refusal: refusalMessage,
            },
            {
              type: "output_text",
              text: contentMessage,
              annotations: [],
            },
          ],
        },
      ],
      usage: this.response.usage,
    } as unknown as OpenAiResponsesResponse;
  }

  withReplacedText(text: string): OpenAiResponsesResponse {
    return {
      ...this.response,
      status: "completed",
      // Replaces output_text so the completed envelope does not retain withheld text.
      output_text: text,
      output: [
        {
          id: `msg_${randomUUID()}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    } as unknown as OpenAiResponsesResponse;
  }
}

class OpenAiResponsesCompactResponseAdapter
  implements LLMResponseAdapter<CompactedResponse>
{
  readonly provider = "openai" as const;

  constructor(private readonly response: CompactedResponse) {}

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    // The compact endpoint's native response deliberately carries no model.
    return "";
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
    return fromResponsesUsage(this.response.usage);
  }

  getOriginalResponse(): CompactedResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    return ["completed"];
  }

  toRefusalResponse(): CompactedResponse {
    throw new ApiError(
      500,
      "OpenAI compaction response cannot contain tool calls",
    );
  }
}

/** A failed generation has admitted neither hosted output nor executable calls. */
export function discardUnadmittedResponsesOutput(
  response: OpenAiResponsesResponse,
): OpenAiResponsesResponse {
  // Final item order cannot prove when a message's text was generated: a
  // message started before a hosted call can contain a later continuation.
  const output =
    firstHostedOutputIndex(response.output) === -1 ? response.output : [];
  const retained = output.filter(
    (item) => item.type !== "function_call" && item.type !== "custom_tool_call",
  );
  return {
    ...response,
    output: retained,
    ...("output_text" in response
      ? { output_text: responseOutputText(retained) }
      : {}),
  } as OpenAiResponsesResponse;
}

class OpenAiResponsesStreamAdapter
  implements
    LLMStreamAdapter<OpenAiResponsesStreamChunk, OpenAiResponsesResponse>
{
  readonly provider = "openai" as const;
  readonly state = createStreamAccumulatorState();
  private terminalResponse: OpenAiResponsesResponse | null = null;
  private observedResponse: OpenAiResponsesResponse | null = null;
  private outputItemsByIndex = new Map<
    number,
    OpenAiResponsesResponse["output"][number]
  >();
  private compactionProof: string | null = null;
  private getTextSuffix: ((completedText: string) => string) | null = null;
  private textPrefixIssued = false;
  private issuedPrefix = "";
  private pendingTextTerminalEvents: OpenAiResponsesStreamChunk[] = [];
  private lastTextDelta: {
    itemId: string;
    outputIndex: number;
    contentIndex: number;
  } | null = null;
  private firstTextDelta: OpenAiResponsesStreamAdapter["lastTextDelta"] = null;
  private textByPart = new Map<string, string>();
  /**
   * Calls the model made as custom tool calls, by call id. The completed
   * envelope names them too, but upstream can end without one, or with an
   * empty output, and a custom call must not turn into a function call then.
   */
  private customCallIds = new Set<string>();
  // Set to the refusal text when the streamed response was replaced by a policy
  // refusal, so toProviderResponse persists the refusal — not the captured
  // upstream completion or the blocked tool calls.
  private replacedText: string | null = null;
  private toolCallsByItemId = new Map<
    string,
    { id: string; name: string; arguments: string; namespace?: string }
  >();
  private withholdsHosted = false;
  // Date.now() ids and sequence numbers collide when several frames are built
  // in the same millisecond. Ids are random instead; sequence numbers come
  // from a counter seeded once per adapter, strictly increasing however fast
  // frames are emitted.
  private syntheticSequence = Date.now();
  /**
   * Namespaces declared on this request, by tool name, when that name belongs
   * to exactly one namespace. Codex Responses Lite puts these in an
   * `additional_tools` input item and does not echo them onto the call.
   * A missing namespace is dispatched as `functions`, so `collaboration.spawn_agent`
   * never runs unless the item we hand back names `collaboration`.
   */
  private readonly declaredNamespaces: ReadonlyMap<string, string>;

  constructor(declaredNamespaces?: ReadonlyMap<string, string>) {
    this.declaredNamespaces = declaredNamespaces ?? new Map();
  }
  /**
   * Set from the first hosted call on. What the model wrote after it rests on
   * what that call brought in, so none of it is the client's until ruled on.
   */
  private hosted: {
    textBefore: string;
    outputBefore: OpenAiResponsesResponse["output"];
    events: OpenAiResponsesStreamChunk[];
    items: Map<string, { type?: string }>;
  } | null = null;

  withholdHostedToolCalls(): void {
    this.withholdsHosted = true;
  }

  setTextSuffix(getSuffix: (completedText: string) => string): void {
    this.getTextSuffix = getSuffix;
  }

  setCompactionContext(proof: string): void {
    this.compactionProof = proof;
  }

  processChunk(chunk: OpenAiResponsesStreamChunk): ChunkProcessingResult {
    chunk = this.withDeclaredNamespaces(chunk);
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    if ("response" in chunk) {
      this.observedResponse = chunk.response;
      this.state.responseId = chunk.response.id;
      this.state.model = chunk.response.model;
      if (chunk.response.usage) {
        this.state.usage = fromResponsesUsage(chunk.response.usage);
      }
    }

    const terminal =
      chunk.type === "response.completed" ||
      chunk.type === "response.failed" ||
      chunk.type === "response.incomplete"
        ? chunk
        : null;
    if (terminal) {
      // Capture before adding client-only compaction context, including failures.
      this.terminalResponse =
        terminal.response as unknown as OpenAiResponsesResponse;
      this.state.stopReason =
        terminal.type === "response.completed"
          ? this.state.toolCalls.length > 0
            ? "tool_calls"
            : "stop"
          : terminal.type === "response.failed"
            ? "error"
            : (terminal.response.incomplete_details?.reason ?? "incomplete");
    }
    if (chunk.type === "response.output_item.done") {
      this.outputItemsByIndex.set(chunk.output_index, chunk.item);
    }
    chunk = this.withCompactionContext(chunk);

    if (
      this.withholdsHosted &&
      this.hosted === null &&
      chunk.type === "response.output_item.added" &&
      firstHostedOutputIndex([chunk.item]) === 0
    ) {
      this.hosted = {
        textBefore: this.state.text,
        outputBefore: structuredClone(
          (terminal
            ? []
            : holdResponsesHostedOutput(this.toProviderResponse().output, [])
          ).filter(
            (item) =>
              item.type !== "function_call" && item.type !== "custom_tool_call",
          ),
        ),
        events: [],
        items: new Map(),
      };
    }
    // Record starts after freezing the pre-hosted snapshot so the first hosted
    // item cannot displace text already forwarded from an unfinished message.
    // Only messages are tracked here: tool-call items keep accumulating input
    // through captureToolCallChunk, and their incomplete `added` snapshot would
    // displace the accumulated call in toProviderResponse.
    if (
      chunk.type === "response.output_item.added" &&
      chunk.item.type === "message"
    ) {
      this.outputItemsByIndex.set(chunk.output_index, chunk.item);
    }
    if (this.hosted) {
      return this.withholdChunk(chunk, this.hosted);
    }

    if (chunk.type === "response.output_text.delta") {
      const pending = this.drainPendingTextTerminalEvents();
      this.state.text += chunk.delta;
      const partKey = this.textPartKey({
        itemId: chunk.item_id,
        outputIndex: chunk.output_index,
        contentIndex: chunk.content_index,
      });
      this.textByPart.set(
        partKey,
        `${this.textByPart.get(partKey) ?? ""}${chunk.delta}`,
      );
      this.lastTextDelta = {
        itemId: chunk.item_id,
        outputIndex: chunk.output_index,
        contentIndex: chunk.content_index,
      };
      this.firstTextDelta ??= this.lastTextDelta;
      let prefixSse = "";
      let outbound = chunk;
      if (!this.textPrefixIssued && this.getTextSuffix) {
        const prefix = this.resolveTextPrefix(chunk.delta);
        this.textPrefixIssued = true;
        if (prefix) {
          this.issuedPrefix = prefix;
          prefixSse = toSse({ ...chunk, delta: prefix });
          outbound = { ...chunk, delta: `\n\n${chunk.delta}` };
        }
      }
      return {
        sseData: `${pending}${prefixSse}${toSse(outbound)}`,
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    if (
      this.getTextSuffix &&
      this.isTextTerminalEvent(chunk, this.lastTextDelta)
    ) {
      this.pendingTextTerminalEvents.push(chunk);
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    if (isResponsesToolCallChunk(chunk)) {
      this.captureToolCallChunk(chunk);
      // If a turn starts with tool calls, captures the prefix now
      // so the completed response carries the trajectory banner.
      if (!this.textPrefixIssued && this.getTextSuffix) {
        const prefix = this.resolveTextPrefix("");
        this.textPrefixIssued = true;
        if (prefix) {
          this.issuedPrefix = prefix;
          this.state.text = prefix;
        }
      }
      this.state.rawToolCallEvents.push(chunk);
      return {
        sseData: null,
        isToolCallChunk: true,
        isFinal: false,
      };
    }

    if (terminal && "response" in chunk) {
      const pending = this.drainPendingTextTerminalEvents();

      // A Responses client treats this envelope as the end of the turn. When
      // tool-call fragments are being held for policy evaluation, forwarding
      // `response.completed` now makes the client exit before the approved
      // calls are released. Buffer the terminal envelope with those fragments
      // so the client observes function calls first and completion last.
      if (
        this.state.toolCalls.length > 0 ||
        terminal.type !== "response.completed"
      ) {
        this.state.rawToolCallEvents.push(chunk);
        return {
          sseData: pending || null,
          isToolCallChunk: true,
          isFinal: true,
        };
      }

      const completed = this.issuedPrefix
        ? {
            ...chunk,
            response: prependPrefixToResponse(
              chunk.response as unknown as OpenAiResponsesResponse,
              this.issuedPrefix,
            ),
          }
        : chunk;
      return {
        sseData: `${pending}${toSse(completed)}`,
        isToolCallChunk: false,
        isFinal: true,
      };
    }

    return {
      sseData: `${this.drainPendingTextTerminalEvents()}${toSse(chunk)}`,
      isToolCallChunk: false,
      isFinal: false,
      isResponsePreamble:
        chunk.type === "response.created" ||
        chunk.type === "response.in_progress",
    };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    const responseId = this.state.responseId || `resp_${randomUUID()}`;
    const itemId = `msg_${randomUUID()}`;

    return [
      toSse({
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: this.nextSequenceNumber(),
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
      toSse({
        type: "response.content_part.added",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        part: {
          type: "output_text",
          text: "",
          annotations: [],
        },
      }),
      toSse({
        type: "response.output_text.delta",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        delta: text,
        logprobs: [],
      }),
      toSse({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        text,
        logprobs: [],
      }),
      toSse({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: this.nextSequenceNumber(),
        part: {
          type: "output_text",
          text,
          annotations: [],
        },
      }),
      toSse({
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: this.nextSequenceNumber(),
        item: {
          id: itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [
            {
              type: "output_text",
              text,
              annotations: [],
            },
          ],
        },
      }),
      toSse({
        type: "response.completed",
        sequence_number: this.nextSequenceNumber(),
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: this.state.model,
          status: "completed",
          output: [
            {
              id: itemId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text,
                  annotations: [],
                },
              ],
            },
          ],
          // Always numeric, and the tokens actually observed: this is the
          // client's only usage report for a replaced turn.
          usage: toResponsesUsage(this.state.usage),
        },
      }),
    ].join("");
  }

  getRawToolCallEvents(): string[] {
    return [
      ...(this.hosted?.events ?? []),
      ...this.state.rawToolCallEvents,
    ].map((event) => toSse(event));
  }

  getHostedToolCalls(): HostedToolCall[] {
    return this.hosted
      ? responsesHostedToolCalls([...this.hosted.items.values()])
      : [];
  }

  formatHeldHostedToolCallsSSE(
    notices: StreamAccumulatorState["toolCalls"],
  ): string[] {
    const upstream = this.terminalResponse;
    // Keep the observed envelope before clearing private output state. Only
    // the output rebuilt below is approved for the replacement turn.
    const envelope = upstream ?? this.toProviderResponse();
    const outputBefore = this.hosted?.outputBefore;
    this.state.text = this.hosted?.textBefore ?? this.state.text;
    this.state.rawToolCallEvents = [];
    this.state.toolCalls = [...notices];
    this.state.stopReason = "tool_calls";
    this.toolCallsByItemId.clear();
    this.customCallIds.clear();
    this.hosted = null;
    this.terminalResponse = null;
    this.observedResponse = null;
    this.outputItemsByIndex.clear();
    // A terminal message can extend a pre-hosted item with unadmitted text,
    // or omit it entirely. Only the frozen pre-hosted output is authoritative.
    const output = outputBefore
      ? holdResponsesHostedOutput(outputBefore, notices)
      : this.toProviderResponse().output;
    const base = {
      ...envelope,
      output,
      ...("output_text" in envelope
        ? { output_text: responseOutputText(output) }
        : {}),
    };
    const held = {
      ...base,
      status: "completed",
      error: null,
      incomplete_details: null,
      usage: base.usage ?? toResponsesUsage(this.state.usage),
    } as unknown as OpenAiResponsesResponse;
    const completedResponse = this.issuedPrefix
      ? prependPrefixToResponse(held, this.issuedPrefix)
      : held;
    this.terminalResponse = completedResponse;
    const frames = formatResponsesFunctionCallFrames({
      toolCalls: notices,
      firstOutputIndex: completedResponse.output.length - notices.length,
      nextSequenceNumber: () => this.nextSequenceNumber(),
    });
    frames.push(
      toSse(
        this.withCompactionContext({
          type: "response.completed",
          sequence_number: this.nextSequenceNumber(),
          response: completedResponse,
        } as OpenAiResponsesStreamChunk),
      ),
    );
    return frames;
  }

  prepareResponseReplacement(): void {
    // Clears raw output state so the persisted turn contains only the approved replacement.
    this.state.text = "";
    this.state.toolCalls = [];
    this.state.rawToolCallEvents = [];
    this.customCallIds.clear();
    this.hosted = null;
    this.terminalResponse = null;
    this.observedResponse = null;
    this.outputItemsByIndex.clear();
  }

  formatCompleteTextSSE(text: string): string[] {
    this.replacedText = text;
    return [this.formatTextDeltaSSE(text)];
  }

  formatToolCallsSSE(toolCalls: StreamAccumulatorState["toolCalls"]): string[] {
    // Rewrites calls without turning an upstream failure into a completion.
    // The final envelope also becomes the persisted one.
    let base = this.toProviderResponse();
    const failed = base.status === "incomplete" || base.status === "failed";
    if (failed) {
      // Terminal snapshots can extend an earlier message with hosted-derived
      // text. Use the frozen pre-hosted snapshot, not only output item order.
      base = this.hosted
        ? {
            ...base,
            output: this.hosted.outputBefore,
            ...("output_text" in base
              ? { output_text: responseOutputText(this.hosted.outputBefore) }
              : {}),
          }
        : discardUnadmittedResponsesOutput(base);
      this.state.text = this.hosted?.textBefore ?? this.state.text;
      toolCalls = [];
    }
    const upstreamOutput = Array.isArray(base.output) ? base.output : [];
    // Removes omitted calls before rebuilding completion envelopes.
    // This makes sure response.completed matches frames sent to the client.
    const finalOutput = withoutOmittedToolCalls(upstreamOutput, toolCalls);
    const callItems = finalOutput.filter(
      (item) =>
        item.type === "function_call" || item.type === "custom_tool_call",
    );
    const itemIdByCallId = new Map(
      callItems.flatMap((item) => {
        const callId = (item as { call_id?: unknown }).call_id;
        const itemId = (item as { id?: unknown }).id;
        return typeof callId === "string" && typeof itemId === "string"
          ? [[callId, itemId] as const]
          : [];
      }),
    );
    const customCallIds = new Set(
      callItems.flatMap((item) => {
        const callId = (item as { call_id?: unknown }).call_id;
        const rewritten = toolCalls.find((call) => call.id === callId);
        // Only a call this rewrite left alone: one replaced by the denial
        // notice is a function call now, because the notice tool is one.
        return item.type === "custom_tool_call" &&
          typeof callId === "string" &&
          rewritten?.name === (item as { name?: string }).name
          ? [callId]
          : [];
      }),
    );
    // A call the envelope did not carry is still known by what was streamed.
    for (const call of toolCalls) {
      const streamed = this.state.toolCalls.find(
        (candidate) => candidate.id === call.id,
      );
      if (this.customCallIds.has(call.id) && streamed?.name === call.name)
        customCallIds.add(call.id);
    }
    const rewritten = {
      ...base,
      output: rewriteResponsesOutput(finalOutput, toolCalls),
      usage:
        base.status === "incomplete" || base.status === "failed"
          ? base.usage
          : (base.usage ?? toResponsesUsage(this.state.usage)),
    } as unknown as OpenAiResponsesResponse;
    const completedResponse = this.issuedPrefix
      ? prependPrefixToResponse(rewritten, this.issuedPrefix)
      : rewritten;
    this.terminalResponse = completedResponse;
    // Both function calls and custom tool calls are counted.
    // This places rewritten frames at indexes that match the completed envelope.
    // The completed output also includes any synthesized prefix message.
    const firstOutputIndex = completedResponse.output.filter(
      (item) =>
        item.type !== "function_call" && item.type !== "custom_tool_call",
    ).length;
    // Released with the turn: what was withheld beside the calls goes first.
    const frames = (failed ? [] : (this.hosted?.events ?? [])).map((event) =>
      toSse(event),
    );
    frames.push(
      ...formatResponsesFunctionCallFrames({
        toolCalls,
        firstOutputIndex,
        nextSequenceNumber: () => this.nextSequenceNumber(),
        itemIdByCallId,
        // Codex routes a namespaced call by the namespace its item names.
        namespaceByCallId: namespacesByCallId({
          items: callItems,
          streamed: this.toolCallsByItemId.values(),
        }),
        customCallIds,
      }),
    );
    frames.push(
      toSse(
        this.withCompactionContext({
          type:
            completedResponse.status === "incomplete"
              ? "response.incomplete"
              : completedResponse.status === "failed"
                ? "response.failed"
                : "response.completed",
          sequence_number: this.nextSequenceNumber(),
          response: completedResponse,
        } as OpenAiResponsesStreamChunk),
      ),
    );
    // A later persistence read must not restore omitted executable fragments.
    this.state.toolCalls = [...toolCalls];
    this.state.rawToolCallEvents = [];
    this.outputItemsByIndex.clear();
    this.hosted = null;
    return frames;
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): OpenAiResponsesResponse {
    const outputItems: OpenAiResponsesResponse["output"] = [];
    const outputStatus: "completed" | "incomplete" =
      this.replacedText === null &&
      this.terminalResponse &&
      this.terminalResponse.status !== "completed"
        ? "incomplete"
        : "completed";

    // A refusal does not erase what the model already said: its text streamed
    // as it arrived and the refusal was appended after it, so the client holds
    // both. Recording the refusal alone deletes the model's own answer from the
    // turn, leaving anything that reads it back — conversation history, a
    // summarizer, a human debugging a run that died — a turn in which the model
    // never spoke.
    //
    // The refusal ships as one more output-text delta, which clients
    // concatenate, so the recorded message text is that concatenation.
    const messageText =
      this.replacedText === null
        ? this.state.text
        : `${this.state.text}${this.replacedText}`;
    if (messageText) {
      outputItems.push({
        id: this.firstTextDelta?.itemId ?? `msg_${randomUUID()}`,
        type: "message",
        role: "assistant",
        status: outputStatus,
        content: [
          {
            type: "output_text",
            text: messageText,
            annotations: [],
          },
        ],
      } as OpenAiResponsesResponse["output"][number]);
    }

    if (this.replacedText === null) {
      outputItems.push(
        ...this.state.toolCalls.map((toolCall) =>
          this.customCallIds.has(toolCall.id)
            ? ({
                id: toolCall.id,
                call_id: toolCall.id,
                type: "custom_tool_call" as const,
                name: toolCall.name,
                input: customToolInput(toolCall.arguments) ?? "",
                ...this.namespaceFields(toolCall),
                status: outputStatus,
              } as OpenAiResponsesResponse["output"][number])
            : {
                id: toolCall.id,
                call_id: toolCall.id,
                type: "function_call" as const,
                name: toolCall.name,
                arguments: toolCall.arguments,
                ...this.namespaceFields(toolCall),
                status: outputStatus,
              },
        ),
      );
    }

    // The upstream terminal envelope is the richest record (it
    // echoes tools, reasoning config and the real ids), so it wins — but only
    // when it actually carries the turn. Reasoning turns finish with an empty
    // `output` even though the text arrived in `response.output_text.delta`
    // chunks; persisting that verbatim lost the whole assistant side of the
    // interaction, leaving LLM Logs with nothing to render. Keep the envelope
    // and restore the items we accumulated.
    const fallbackResponse = {
      ...(this.replacedText === null ? (this.observedResponse ?? {}) : {}),
      id: this.state.responseId || `resp_${randomUUID()}`,
      object: "response",
      created_at:
        this.observedResponse?.created_at ?? Math.floor(Date.now() / 1000),
      model: this.state.model,
      status: "completed",
      output: outputItems,
      usage: this.observedResponse
        ? this.observedResponse.usage
        : this.state.usage
          ? toResponsesUsage(this.state.usage)
          : undefined,
    } as unknown as OpenAiResponsesResponse;
    if (this.replacedText === null) {
      const upstreamOutput = this.terminalResponse?.output ?? [];
      if (
        this.terminalResponse?.status === "completed" &&
        Array.isArray(upstreamOutput) &&
        upstreamOutput.length > 0
      ) {
        return this.stampResponseOutput(this.terminalResponse);
      }
      // A failure envelope can omit items that have already streamed.
      const streamed = [...this.outputItemsByIndex.entries()]
        .sort(([left], [right]) => left - right)
        .map(([outputIndex, item]) => {
          if (item.type !== "message") return item;
          const content = [...item.content];
          for (const [key, text] of this.textByPart) {
            const [itemId, partOutputIndex, contentIndex] = key.split("\u0000");
            if (itemId === item.id && Number(partOutputIndex) === outputIndex) {
              const index = Number(contentIndex);
              const part = content[index];
              content[index] = {
                ...(part?.type === "output_text" ? part : {}),
                type: "output_text",
                text,
                annotations:
                  part?.type === "output_text" ? part.annotations : [],
              };
            }
          }
          return { ...item, content };
        });
      const terminalOutput = Array.isArray(upstreamOutput)
        ? upstreamOutput
        : [];
      const accumulated = [
        ...streamed.map(
          (item) =>
            terminalOutput.find(
              (candidate) => item.id && candidate.id === item.id,
            ) ?? item,
        ),
        ...terminalOutput.filter(
          (item) =>
            !streamed.some((candidate) => item.id && candidate.id === item.id),
        ),
      ];
      const restoredOutput = [
        ...accumulated,
        ...outputItems.filter((item) => {
          if (item.type === "message") {
            return !accumulated.some(
              (candidate) => candidate.type === "message",
            );
          }
          if ("call_id" in item) {
            return !accumulated.some(
              (candidate) =>
                "call_id" in candidate && candidate.call_id === item.call_id,
            );
          }
          return true;
        }),
      ];
      return this.stampResponseOutput({
        ...(this.terminalResponse ?? fallbackResponse),
        output: restoredOutput,
      });
    }

    return fallbackResponse;
  }

  private resolveTextPrefix(firstText: string): string {
    if (!this.getTextSuffix || this.replacedText !== null) {
      return "";
    }
    return this.getTextSuffix(firstText);
  }

  private nextSequenceNumber(): number {
    return this.syntheticSequence++;
  }

  private withCompactionContext(
    chunk: OpenAiResponsesStreamChunk,
  ): OpenAiResponsesStreamChunk {
    const proof = this.compactionProof;
    if (!proof) return chunk;
    if (chunk.type === "response.output_item.done") {
      return {
        ...chunk,
        item: wrapCompactionItem(chunk.item, proof),
      } as OpenAiResponsesStreamChunk;
    }
    if (chunk.type === "response.completed") {
      return {
        ...chunk,
        response: wrapCompactionResponse(chunk.response, proof),
      } as OpenAiResponsesStreamChunk;
    }
    return chunk;
  }

  private textPartKey(params: {
    itemId: string;
    outputIndex: number;
    contentIndex: number;
  }): string {
    return `${params.itemId}\u0000${params.outputIndex}\u0000${params.contentIndex}`;
  }

  private isTextTerminalEvent(
    chunk: OpenAiResponsesStreamChunk,
    textDelta: OpenAiResponsesStreamAdapter["lastTextDelta"],
  ): boolean {
    if (!textDelta) return false;
    if (chunk.type === "response.output_text.done") {
      return (
        chunk.item_id === textDelta.itemId &&
        chunk.output_index === textDelta.outputIndex &&
        chunk.content_index === textDelta.contentIndex
      );
    }
    if (chunk.type === "response.content_part.done") {
      return (
        chunk.item_id === textDelta.itemId &&
        chunk.output_index === textDelta.outputIndex &&
        chunk.content_index === textDelta.contentIndex &&
        chunk.part.type === "output_text"
      );
    }
    return (
      chunk.type === "response.output_item.done" &&
      chunk.output_index === textDelta.outputIndex &&
      chunk.item.type === "message" &&
      chunk.item.id === textDelta.itemId &&
      chunk.item.content[textDelta.contentIndex]?.type === "output_text"
    );
  }

  private drainPendingTextTerminalEvents(): string {
    // Completed snapshots must carry the receipt only where its delta was sent.
    const events = this.pendingTextTerminalEvents.map((event) =>
      toSse(
        this.issuedPrefix &&
          this.isTextTerminalEvent(event, this.firstTextDelta)
          ? prependPrefixToTerminalEvent(event, this.issuedPrefix)
          : event,
      ),
    );
    this.pendingTextTerminalEvents = [];
    return events.join("");
  }

  /** Accumulates a chunk of the provider-run part of the turn without forwarding it. */
  private withholdChunk(
    chunk: OpenAiResponsesStreamChunk,
    hosted: NonNullable<OpenAiResponsesStreamAdapter["hosted"]>,
  ): ChunkProcessingResult {
    if (
      chunk.type === "response.output_item.added" ||
      chunk.type === "response.output_item.done"
    ) {
      const item = chunk.item as { id?: string; type?: string };
      if (typeof item.id === "string") hosted.items.set(item.id, item);
    }
    if (chunk.type === "response.output_text.delta") {
      this.state.text += chunk.delta;
    }
    const isFinal =
      chunk.type === "response.completed" ||
      chunk.type === "response.failed" ||
      chunk.type === "response.incomplete";
    // Calls stay where the release path reads them; the terminal frame joins
    // them so it still reaches the client last.
    if (isResponsesToolCallChunk(chunk)) {
      this.captureToolCallChunk(chunk);
      this.state.rawToolCallEvents.push(chunk);
    } else if (isFinal) {
      this.state.rawToolCallEvents.push(chunk);
    } else {
      hosted.events.push(chunk);
    }
    return { sseData: null, isToolCallChunk: true, isFinal };
  }

  private captureToolCallChunk(chunk: OpenAiResponsesStreamChunk): void {
    if (chunk.type === "response.output_item.added") {
      const item = chunk.item;
      if (isResponseCustomToolCall(item)) {
        this.rememberCall(item.id ?? item.call_id, {
          id: item.call_id,
          name: item.name,
          arguments: JSON.stringify({ input: item.input ?? "" }),
          ...namespaceOf(item),
        });
        this.customCallIds.add(item.call_id);
        return;
      }
      if (!isResponseFunctionCall(item)) {
        return;
      }

      this.rememberCall(item.id ?? item.call_id, {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
        ...namespaceOf(item),
      });
      return;
    }

    if (chunk.type === "response.output_item.done") {
      const item = chunk.item;
      if (isResponseCustomToolCall(item)) {
        this.rememberCall(item.id ?? item.call_id, {
          id: item.call_id,
          name: item.name,
          arguments: item.input ? JSON.stringify({ input: item.input }) : "",
          ...namespaceOf(item),
        });
        this.customCallIds.add(item.call_id);
        return;
      }
      if (!isResponseFunctionCall(item)) return;
      const key = item.id ?? item.call_id;
      const existing = this.toolCallsByItemId.get(key);
      this.rememberCall(key, {
        id: item.call_id,
        name: item.name || existing?.name || "",
        arguments: item.arguments || existing?.arguments || "",
        ...namespaceOf(item),
        ...(existing?.namespace && !namespaceOf(item).namespace
          ? { namespace: existing.namespace }
          : {}),
      });
      return;
    }

    // A custom tool's input streams as text, not as JSON argument fragments.
    if (
      chunk.type === "response.custom_tool_call_input.delta" ||
      chunk.type === "response.custom_tool_call_input.done"
    ) {
      const toolCall = this.toolCallsByItemId.get(chunk.item_id);
      if (!toolCall) return;
      const input =
        chunk.type === "response.custom_tool_call_input.done"
          ? chunk.input
          : (customToolInput(toolCall.arguments) ?? "") + chunk.delta;
      toolCall.arguments = JSON.stringify({ input });
      this.toolCallsByItemId.set(chunk.item_id, toolCall);
      this.state.toolCalls = Array.from(this.toolCallsByItemId.values());
      return;
    }

    if (chunk.type === "response.function_call_arguments.delta") {
      const toolCall = this.toolCallsByItemId.get(chunk.item_id) ?? {
        id: chunk.item_id,
        name: "",
        arguments: "",
      };
      toolCall.arguments += chunk.delta;
      this.toolCallsByItemId.set(chunk.item_id, toolCall);
      this.state.toolCalls = Array.from(this.toolCallsByItemId.values());

      return;
    }

    if (chunk.type === "response.function_call_arguments.done") {
      this.updateToolCallArguments(chunk);
    }
  }

  private updateToolCallArguments(
    chunk:
      | ResponseFunctionCallArgumentsDoneEvent
      | ResponseFunctionCallArgumentsDeltaEvent,
  ): void {
    const toolCall = this.toolCallsByItemId.get(chunk.item_id) ?? {
      id: chunk.item_id,
      name: "name" in chunk ? chunk.name : "",
      arguments: "",
    };

    if ("name" in chunk) {
      toolCall.name = chunk.name;
      toolCall.arguments = chunk.arguments;
    }

    this.rememberCall(chunk.item_id, toolCall);
  }

  /**
   * Codex routes a namespaced tool by the namespace on the function-call item.
   * `response.function_call_arguments.done` has no namespace field. A Lite
   * request declares the namespace in `additional_tools` and the model often
   * omits it; without it the client treats the call as `functions.<name>`.
   */
  private withDeclaredNamespaces(
    chunk: OpenAiResponsesStreamChunk,
  ): OpenAiResponsesStreamChunk {
    if (
      chunk.type === "response.output_item.added" ||
      chunk.type === "response.output_item.done"
    ) {
      const item = this.stampCallItem(chunk.item);
      return item === chunk.item
        ? chunk
        : ({ ...chunk, item } as OpenAiResponsesStreamChunk);
    }
    if (
      chunk.type === "response.completed" &&
      Array.isArray(chunk.response?.output)
    ) {
      return {
        ...chunk,
        response: this.stampResponseOutput(
          chunk.response as unknown as OpenAiResponsesResponse,
        ),
      } as OpenAiResponsesStreamChunk;
    }
    return chunk;
  }

  private stampResponseOutput(
    response: OpenAiResponsesResponse,
  ): OpenAiResponsesResponse {
    if (!Array.isArray(response.output)) return response;
    let changed = false;
    const output = response.output.map((item) => {
      const stamped = this.stampCallItem(item);
      if (stamped !== item) changed = true;
      return stamped;
    });
    return changed ? { ...response, output } : response;
  }

  private stampCallItem<T>(item: T): T {
    return stampDeclaredNamespace(item, this.declaredNamespaces);
  }

  private namespaceFields(toolCall: { name: string; namespace?: string }): {
    namespace?: string;
  } {
    const namespace = toolCall.namespace || this.namespaceFor(toolCall.name);
    return namespace ? { namespace } : {};
  }

  private namespaceFor(name: string | undefined): string | undefined {
    if (!name) return undefined;
    return this.declaredNamespaces.get(name);
  }

  private rememberCall(
    key: string,
    call: { id: string; name: string; arguments: string; namespace?: string },
  ): void {
    const existing = this.toolCallsByItemId.get(key);
    const namespace =
      call.namespace ||
      existing?.namespace ||
      this.namespaceFor(call.name || existing?.name);
    const next = {
      id: call.id || existing?.id || key,
      name: call.name || existing?.name || "",
      arguments: call.arguments || existing?.arguments || "",
      ...(namespace ? { namespace } : {}),
    };
    this.toolCallsByItemId.set(key, next);
    this.backfillHeldItem(key, next.name, namespace);
    this.state.toolCalls = Array.from(this.toolCallsByItemId.values());
  }

  private backfillHeldItem(
    key: string,
    name: string,
    namespace: string | undefined,
  ): void {
    if (!namespace) return;
    let events: unknown[] | undefined;
    for (const [index, event] of this.state.rawToolCallEvents.entries()) {
      if (
        !isRecord(event) ||
        !isRecord(event.item) ||
        (event.type !== "response.output_item.added" &&
          event.type !== "response.output_item.done")
      ) {
        continue;
      }
      const item = event.item as {
        id?: string;
        call_id?: string;
        name?: string;
        namespace?: string;
      };
      if (item.id !== key && item.call_id !== key) continue;
      if (item.namespace && (item.name || !name)) continue;
      events ??= [...this.state.rawToolCallEvents];
      events[index] = {
        ...event,
        item: {
          ...item,
          ...(!item.namespace ? { namespace } : {}),
          ...(!item.name && name ? { name } : {}),
        },
      };
    }
    if (events) this.state.rawToolCallEvents = events;
  }
}

function stampDeclaredNamespace<T>(
  item: T,
  namespaces: ReadonlyMap<string, string>,
): T {
  if (!item || typeof item !== "object") return item;
  const record = item as { type?: string; name?: string; namespace?: unknown };
  if (record.type !== "function_call" && record.type !== "custom_tool_call")
    return item;
  if (typeof record.namespace === "string" && record.namespace !== "") {
    return record.name?.startsWith(`${record.namespace}.`) &&
      namespaces.get(record.name) === record.namespace
      ? { ...item, name: record.name.slice(record.namespace.length + 1) }
      : item;
  }
  const namespace = record.name ? namespaces.get(record.name) : undefined;
  return namespace
    ? {
        ...item,
        namespace,
        ...(record.name?.startsWith(`${namespace}.`)
          ? { name: record.name.slice(namespace.length + 1) }
          : {}),
      }
    : item;
}

/**
 * Tool name to namespace, only when the request declares that name in exactly
 * one namespace. A collision is left unset so a call is not routed to the
 * wrong handler.
 */
function uniqueDeclaredNamespaces(
  request: OpenAiResponsesRequest | undefined,
): ReadonlyMap<string, string> {
  const namespaces = new Map<string, string>();
  const ambiguous = new Set<string>();
  if (!request) return namespaces;
  for (const tools of toolDeclarationLists(request)) {
    for (const tool of tools) {
      if (
        isRecord(tool) &&
        (tool.type === "function" || tool.type === "custom")
      ) {
        const name = declaredMemberName(tool);
        if (name) {
          ambiguous.add(name);
          namespaces.delete(name);
        }
        continue;
      }
      if (
        !isRecord(tool) ||
        tool.type !== "namespace" ||
        !Array.isArray(tool.tools)
      ) {
        continue;
      }
      const namespace = tool.name;
      if (typeof namespace !== "string" || namespace === "") continue;
      for (const member of tool.tools) {
        const name = declaredMemberName(member);
        if (!name) continue;
        const qualified = `${namespace}.${name}`;
        if (!ambiguous.has(qualified)) namespaces.set(qualified, namespace);
        if (ambiguous.has(name)) continue;
        const existing = namespaces.get(name);
        if (existing && existing !== namespace) {
          ambiguous.add(name);
          namespaces.delete(name);
          continue;
        }
        namespaces.set(name, namespace);
      }
    }
  }
  return namespaces;
}

function toolDeclarationLists(request: OpenAiResponsesRequest): unknown[][] {
  const record = request as unknown as Record<string, unknown>;
  const lists: unknown[][] = [];
  for (const key of ["tools", "additional_tools"] as const) {
    if (Array.isArray(record[key])) lists.push(record[key] as unknown[]);
  }
  if (!Array.isArray(request.input)) return lists;
  for (const input of request.input) {
    const item: unknown = input;
    if (
      !isRecord(item) ||
      (item.type !== "additional_tools" &&
        item.type !== "tool_search_output") ||
      !Array.isArray(item.tools)
    ) {
      continue;
    }
    lists.push(item.tools);
  }
  return lists;
}

function declaredMemberName(tool: unknown): string | undefined {
  if (!isRecord(tool)) return undefined;
  if (typeof tool.name === "string" && tool.name !== "") return tool.name;
  for (const nested of [tool.function, tool.custom]) {
    if (
      !isRecord(nested) ||
      typeof nested.name !== "string" ||
      nested.name === ""
    ) {
      continue;
    }
    return nested.name;
  }
  return undefined;
}

function responseOutputText(output: OpenAiResponsesResponse["output"]): string {
  return output
    .flatMap((item) =>
      item.type === "message"
        ? item.content.flatMap((part) =>
            part.type === "output_text" ? [part.text] : [],
          )
        : [],
    )
    .join("");
}

function withoutOmittedToolCalls<TItem extends { type?: string }>(
  output: readonly TItem[],
  toolCalls: readonly { id: string }[],
): TItem[] {
  const releasedCallIds = new Set(toolCalls.map((call) => call.id));
  return output.filter((item) => {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") {
      return true;
    }
    const callId = (item as { call_id?: unknown }).call_id;
    return typeof callId === "string" && releasedCallIds.has(callId);
  });
}

function toCompactRequest(request: OpenAiCompactRequest): OpenAiCompactRequest {
  return {
    model: request.model,
    input: request.input,
    instructions: request.instructions,
    previous_response_id: request.previous_response_id,
    prompt_cache_key: request.prompt_cache_key,
  };
}

function toCommonMessages(
  item: ResponseInputItem,
  toolCallsByCallId: Map<string, HistoryToolCall>,
): CommonMessage[] {
  // "easy input message" items carry role/content and omit `type` (it defaults
  // to "message"); the AI SDK emits this shape. Without handling it here,
  // getMessages() drops the user's prompt and trusted-data / Dual LLM policy
  // evaluation (llm-proxy-handler) silently sees an empty conversation.
  if ((item.type === "message" || item.type === undefined) && "role" in item) {
    return [
      {
        role: normalizeResponseMessageRole(item.role),
        content: extractResponseInputText(item.content),
      },
    ];
  }

  if (
    item.type === "function_call_output" ||
    item.type === "custom_tool_call_output"
  ) {
    const toolCall = toolCallsByCallId.get(item.call_id);
    const content =
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output);
    return [
      {
        role: "tool",
        content,
        // An output whose function_call was pruned from the input still
        // carries untrusted data — surface it under the "unknown" name so
        // default trusted-data policies apply rather than nothing.
        toolCalls: [
          {
            id: item.call_id,
            name: toolCall?.name ?? "unknown",
            ...(toolCall?.namespace ? { namespace: toolCall.namespace } : {}),
            arguments: toolCall?.arguments,
            content,
            isError: "is_error" in item && item.is_error === true,
          },
        ],
      },
    ];
  }

  return [];
}

function extractResponseInputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object" || !("type" in part)) {
        return [];
      }

      if (part.type === "input_text" && "text" in part) {
        return typeof part.text === "string" ? [part.text] : [];
      }

      if (part.type === "output_text" && "text" in part) {
        return typeof part.text === "string" ? [part.text] : [];
      }

      return [];
    })
    .join("\n");
}

function isFunctionToolDefinition(
  tool: unknown,
): tool is OpenAiFunctionToolDefinition {
  return (
    !!tool &&
    typeof tool === "object" &&
    "type" in tool &&
    tool.type === "function"
  );
}

/**
 * A tool result item, of either kind: a custom tool's output is a result the
 * same way a function's is, and a proxy that read only one of them would hand
 * the other back to the model ungoverned.
 */
function isFunctionCallOutputItem(
  item: unknown,
): item is Extract<
  ResponseInputItem,
  { type: "function_call_output" | "custom_tool_call_output" }
> {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output")
  );
}

function isResponseMessage(
  item: ResponseOutputItem,
): item is Extract<ResponseOutputItem, { type: "message" }> {
  return item.type === "message";
}

function isResponseFunctionCall(
  item: ResponseOutputItem | { type?: string },
): item is Extract<ResponseOutputItem, { type: "function_call" }> {
  return item.type === "function_call";
}

function isResponseCustomToolCall(
  item: ResponseOutputItem | { type?: string },
): item is Extract<ResponseOutputItem, { type: "custom_tool_call" }> {
  return item.type === "custom_tool_call";
}

function isResponseInputCustomToolCall(
  item: ResponseInputItem,
): item is Extract<ResponseInputItem, { type: "custom_tool_call" }> {
  return item.type === "custom_tool_call";
}

function isResponseInputFunctionCall(
  item: ResponseInputItem,
): item is Extract<ResponseInputItem, { type: "function_call" }> {
  return item.type === "function_call";
}

function normalizeResponseMessageRole(
  role: "user" | "system" | "assistant" | "developer",
): CommonMessage["role"] {
  return role === "developer" ? "system" : role;
}

function isResponsesToolCallChunk(
  chunk: ResponseStreamEvent,
): chunk is
  | Extract<ResponseStreamEvent, { type: "response.output_item.added" }>
  | Extract<ResponseStreamEvent, { type: "response.output_item.done" }>
  | ResponseFunctionCallArgumentsDeltaEvent
  | ResponseFunctionCallArgumentsDoneEvent
  | Extract<
      ResponseStreamEvent,
      { type: "response.custom_tool_call_input.delta" }
    >
  | Extract<
      ResponseStreamEvent,
      { type: "response.custom_tool_call_input.done" }
    > {
  const item =
    chunk.type === "response.output_item.added" ||
    chunk.type === "response.output_item.done"
      ? chunk.item
      : undefined;
  return (
    (item !== undefined &&
      (isResponseFunctionCall(item) || isResponseCustomToolCall(item))) ||
    chunk.type === "response.function_call_arguments.delta" ||
    chunk.type === "response.function_call_arguments.done" ||
    chunk.type === "response.custom_tool_call_input.delta" ||
    chunk.type === "response.custom_tool_call_input.done"
  );
}

/**
 * A call in the request history, as its output is paired with it. A Codex call
 * to a namespaced tool names that namespace, which is part of which tool it
 * called.
 */
type HistoryToolCall = {
  name: string;
  namespace?: string;
  arguments?: Record<string, unknown>;
};

function getToolCallsByCallId(
  input: ResponseInputItem[],
): Map<string, HistoryToolCall> {
  return new Map(
    input.flatMap((item): Array<[string, HistoryToolCall]> => {
      if (isResponseInputCustomToolCall(item)) {
        return [
          [
            item.call_id,
            {
              name: item.name,
              ...namespaceOf(item),
              arguments: { input: item.input },
            },
          ],
        ];
      }
      if (!isResponseInputFunctionCall(item)) {
        return [];
      }

      return [
        [
          item.call_id,
          {
            name: item.name,
            ...namespaceOf(item),
            arguments: extractCommonToolCallArguments(item.arguments),
          },
        ],
      ];
    }),
  );
}

function tryParseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function withLeadingPrefix(text: string, prefix: string): string {
  return text.startsWith(prefix) ? text : `${prefix}\n\n${text}`;
}

function prependPrefixToTerminalEvent(
  event: OpenAiResponsesStreamChunk,
  prefix: string,
): OpenAiResponsesStreamChunk {
  if (event.type === "response.output_text.done") {
    return { ...event, text: withLeadingPrefix(event.text, prefix) };
  }
  if (event.type === "response.content_part.done") {
    const part = event.part as { type: string; text?: string };
    if (part.type !== "output_text" || part.text === undefined) return event;
    return {
      ...event,
      part: { ...part, text: withLeadingPrefix(part.text, prefix) },
    } as OpenAiResponsesStreamChunk;
  }
  if (event.type === "response.output_item.done") {
    const item = event.item as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (!item.content) return event;
    let applied = false;
    return {
      ...event,
      item: {
        ...item,
        content: item.content.map((part) => {
          if (applied || part.type !== "output_text" || part.text === undefined)
            return part;
          applied = true;
          return { ...part, text: withLeadingPrefix(part.text, prefix) };
        }),
      },
    } as OpenAiResponsesStreamChunk;
  }
  return event;
}
