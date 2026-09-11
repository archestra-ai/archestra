import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ResponseCompactParams,
  ResponseCreateParamsNonStreaming,
  ResponseCreateParamsStreaming,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseFunctionCallArgumentsDoneEvent,
  ResponseInput,
  ResponseInputItem,
  ResponseMcpCallArgumentsDeltaEvent,
  ResponseMcpCallArgumentsDoneEvent,
  ResponseOutputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import config from "@/config";
import { metrics } from "@/observability";
import {
  decodeOpenAiCodexCredential,
  isOpenAiCodexCredential,
} from "@/services/openai-codex-credentials";
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
  OpenAi,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { ApiError, createStreamAccumulatorState } from "@/types";
import { createOpenAiCodexResponsesClient } from "./openai-codex-responses-client";
import { formatResponsesStreamErrorFrame } from "./responses-stream-error-frame";
import {
  formatResponsesFunctionCallFrames,
  rewriteResponsesOutput,
  toSse,
} from "./responses-tool-call-rewrite";
import { fromResponsesUsage, toResponsesUsage } from "./responses-usage";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";
import { subscriptionAuthRequiredCode } from "./subscription-auth-error";

type OpenAiResponsesRequest = OpenAi.Types.ResponsesRequest;
type OpenAiResponsesResponse = OpenAi.Types.ResponsesResponse;
type OpenAiResponsesCompactRequest = OpenAi.Types.ResponsesCompactRequest;
type OpenAiResponsesCompactResponse = OpenAi.Types.ResponsesCompactResponse;
type OpenAiResponsesHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiResponsesStreamChunk = OpenAi.Types.ResponseChunk;
type OpenAiResponseInput = string | ResponseInput | undefined;
type OpenAiResponsesCompatibleRequest = {
  model: string;
  input?: OpenAiResponseInput | null;
  instructions?: string | null;
  tools?: unknown[];
  stream?: boolean | null;
};

type OpenAiFunctionToolDefinition = {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
};

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
  ): LLMResponseAdapter<OpenAiResponsesResponse> {
    return new OpenAiResponsesResponseAdapter(response);
  },

  createStreamAdapter():
    | LLMStreamAdapter<OpenAiResponsesStreamChunk, OpenAiResponsesResponse>
    | never {
    return new OpenAiResponsesStreamAdapter();
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

    return (await openaiClient.responses.create({
      ...request,
      stream: true,
    } as ResponseCreateParamsStreaming)) as AsyncIterable<OpenAiResponsesStreamChunk>;
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

/** The legacy `/responses/compact` endpoint shares proxy policy and auth flow. */
export const openAiResponsesCompactAdapterFactory: LLMProvider<
  OpenAiResponsesCompactRequest,
  OpenAiResponsesCompactResponse,
  OpenAiResponseInput,
  OpenAiResponsesStreamChunk,
  OpenAiResponsesHeaders
> = {
  ...openAiResponsesAdapterFactory,

  createRequestAdapter(request) {
    return new OpenAiResponsesRequestAdapter(request);
  },

  createResponseAdapter(response) {
    return new OpenAiResponsesCompactResponseAdapter(response);
  },

  createStreamAdapter() {
    // The route schema rejects `stream`; this satisfies the shared provider
    // interface without exposing an invented compact streaming protocol.
    return new OpenAiResponsesStreamAdapter() as unknown as LLMStreamAdapter<
      OpenAiResponsesStreamChunk,
      OpenAiResponsesCompactResponse
    >;
  },

  async execute(client, request) {
    const openaiClient = client as OpenAIProvider;
    return (await openaiClient.responses.compact(
      request as ResponseCompactParams,
    )) as OpenAiResponsesCompactResponse;
  },

  async executeStream() {
    throw new ApiError(400, "Responses compact does not support streaming.");
  },
};

class OpenAiResponsesRequestAdapter<
  TRequest extends OpenAiResponsesCompatibleRequest,
> implements LLMRequestAdapter<TRequest, OpenAiResponseInput>
{
  readonly provider = "openai" as const;
  private request: TRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: TRequest) {
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

    // Pair native tool outputs with their call by call_id so
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
      if (!isResponsesToolOutputItem(item)) {
        return [];
      }

      const toolCall = toolCallsByCallId.get(item.call_id);
      return [
        {
          id: item.call_id,
          name: toolCall?.name ?? "unknown",
          arguments: toolCall?.arguments,
          content: stringifyResponseToolOutput(item.output),
          isError: false,
        },
      ];
    });
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!Array.isArray(this.request.tools)) {
      return [];
    }

    return this.request.tools.flatMap((tool) => {
      if (isFunctionToolDefinition(tool)) {
        return [
          {
            name: tool.name,
            description: tool.description ?? undefined,
            inputSchema: tool.parameters ?? {},
          },
        ];
      }
      return declaredResponsesMcpTools(tool);
    });
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): OpenAiResponseInput {
    return this.request.input ?? undefined;
  }

  getOriginalRequest(): TRequest {
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

  async applyToonCompression(_model: string): Promise<ToolCompressionStats> {
    // Responses tool outputs are already structured as function_call_output items,
    // so there is no JSON blob to compress with TOON before forwarding upstream.
    return createEmptyToolCompressionStats();
  }

  convertToolResultContent(input: OpenAiResponseInput): OpenAiResponseInput {
    // OpenAI Responses accepts tool results in their native function_call_output
    // shape, so the proxy should pass them through unchanged.
    return input;
  }

  toProviderRequest(): TRequest {
    if (!Array.isArray(this.request.input)) {
      return {
        ...this.request,
        model: this.getModel(),
      } as TRequest;
    }

    return {
      ...this.request,
      model: this.getModel(),
      input: this.request.input.map((item) => {
        if (!isResponsesToolOutputItem(item)) {
          return item;
        }

        const updatedOutput = this.toolResultUpdates[item.call_id];
        if (!updatedOutput) {
          return item;
        }

        return {
          ...item,
          output: updatedOutput,
        };
      }) as unknown as ResponseInput,
    } as TRequest;
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
    assertNoUnsupportedResponsesToolItems(this.response.output);
    return this.response.output.flatMap((item) => {
      if (!isResponseNativeToolCall(item)) {
        return [];
      }

      return [
        {
          id: responseToolCallId(item),
          name: codexToolName(item),
          arguments: tryParseJsonObject(responseToolCallArguments(item)),
        },
      ];
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
    if (this.hasToolCalls()) {
      return ["tool_calls"];
    }

    return [this.response.status ?? "completed"];
  }

  withRewrittenToolCalls(
    toolCalls: Array<{ id: string; name: string; arguments: string }>,
  ): OpenAiResponsesResponse {
    return {
      ...this.response,
      output: rewriteResponsesOutput(this.response.output, toolCalls),
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
          id: `msg_${Date.now()}`,
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
}

class OpenAiResponsesCompactResponseAdapter
  implements LLMResponseAdapter<OpenAiResponsesCompactResponse>
{
  readonly provider = "openai" as const;

  constructor(private response: OpenAiResponsesCompactResponse) {}

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    // Compaction responses intentionally omit the model; the handler retains
    // the request-selected model for interaction and cost attribution.
    return "";
  }

  getText(): string {
    // A compaction item is opaque provider context, never model-visible text.
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

  getOriginalResponse(): OpenAiResponsesCompactResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    return ["compacted"];
  }

  toRefusalResponse(): OpenAiResponsesCompactResponse {
    // Compact responses cannot emit tool calls, so the policy-refusal branch is
    // unreachable. Preserve the upstream wire shape if that invariant changes.
    return this.response;
  }
}

class OpenAiResponsesStreamAdapter
  implements
    LLMStreamAdapter<OpenAiResponsesStreamChunk, OpenAiResponsesResponse>
{
  readonly provider = "openai" as const;
  readonly state = createStreamAccumulatorState();
  private completedResponse: OpenAiResponsesResponse | null = null;
  private completedItems = new Map<
    string,
    OpenAiResponsesResponse["output"][number]
  >();
  // Set to the refusal text when the streamed response was replaced by a policy
  // refusal, so toProviderResponse persists the refusal — not the captured
  // upstream completion or the blocked tool calls.
  private replacedText: string | null = null;
  private toolCallsByItemId = new Map<
    string,
    {
      id: string;
      name: string;
      arguments: string;
      originalItem?: Record<string, unknown>;
    }
  >();
  private pendingToolSearchEvents = new Map<string, string>();

  processChunk(chunk: OpenAiResponsesStreamChunk): ChunkProcessingResult {
    // Stock Codex emits nameless tool-search bookkeeping. It is not an
    // executable function call, so hold every added record until its terminal
    // client-execution discriminator is present and the native bridge can seal
    // its call/item/argument identity before it reaches the client.
    if (
      chunk.type === "response.output_item.added" &&
      isToolSearchCallBookkeeping(chunk.item)
    ) {
      if (chunk.item.execution === "server") {
        throw unsupportedResponsesToolItemError(chunk.item);
      }
      this.pendingToolSearchEvents.set(chunk.item.call_id, toSse(chunk));
      return { sseData: null, isToolCallChunk: true, isFinal: false };
    }
    if (
      chunk.type === "response.output_item.done" &&
      isToolSearchCallBookkeeping(chunk.item)
    ) {
      if (chunk.item.execution !== "client") {
        throw unsupportedResponsesToolItemError(chunk.item);
      }
      const pending = this.pendingToolSearchEvents.get(chunk.item.call_id);
      this.pendingToolSearchEvents.delete(chunk.item.call_id);
      this.completedItems.set(chunk.item.id, chunk.item as never);
      // Do not add search bookkeeping to `toolCalls`: it must never reach the
      // APPA executable-call authorization path.
      return {
        sseData: [pending, toSse(chunk)].filter(Boolean).join(""),
        isToolCallChunk: true,
        isFinal: false,
      };
    }
    if (
      (chunk.type === "response.output_item.added" ||
        chunk.type === "response.output_item.done") &&
      isUnsupportedResponsesToolItem(chunk.item)
    ) {
      throw unsupportedResponsesToolItemError(chunk.item);
    }
    if (chunk.type === "response.output_item.done") {
      const item = chunk.item as OpenAiResponsesResponse["output"][number];
      const key =
        "id" in item && typeof item.id === "string"
          ? item.id
          : `position:${chunk.output_index}`;
      const previous = this.completedItems.get(key);
      if (previous && JSON.stringify(previous) !== JSON.stringify(item))
        throw new Error("Conflicting completed Responses item");
      this.completedItems.set(key, item);
      if (item.type === "message") {
        this.state.text = Array.from(this.completedItems.values())
          .filter((value) => value.type === "message")
          .flatMap((value) =>
            value.type === "message"
              ? value.content
                  .filter((part) => part.type === "output_text")
                  .map((part) => (part.type === "output_text" ? part.text : ""))
              : [],
          )
          .join("");
      }
    }
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    if ("response" in chunk) {
      this.state.responseId = chunk.response.id;
      this.state.model = chunk.response.model;
      if (chunk.response.usage) {
        this.state.usage = fromResponsesUsage(chunk.response.usage);
      }
    }

    if (chunk.type === "response.output_text.delta") {
      this.state.text += chunk.delta;
      return {
        sseData: toSse(chunk),
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    if (isResponsesToolCallChunk(chunk)) {
      this.captureToolCallChunk(chunk);
      this.state.rawToolCallEvents.push(chunk);
      return {
        sseData: null,
        isToolCallChunk: true,
        isFinal: false,
      };
    }

    if (chunk.type === "response.completed") {
      this.completedResponse =
        chunk.response as unknown as OpenAiResponsesResponse;
      assertNoUnsupportedResponsesToolItems(
        this.completedResponse.output ?? [],
      );
      for (const item of this.completedResponse.output ?? []) {
        if (!isResponseNativeToolCall(item)) continue;
        const callId = responseToolCallId(item);
        this.toolCallsByItemId.set(item.id ?? callId, {
          id: callId,
          name: codexToolName(item),
          arguments: responseToolCallArguments(item),
          originalItem: item as unknown as Record<string, unknown>,
        });
      }
      this.state.toolCalls = Array.from(this.toolCallsByItemId.values());
      this.state.stopReason =
        this.state.toolCalls.length > 0 ? "tool_calls" : "stop";

      // A Responses client treats this envelope as the end of the turn. When
      // tool-call fragments are being held for policy evaluation, forwarding
      // `response.completed` now makes the client exit before the approved
      // calls are released. Buffer the terminal envelope with those fragments
      // so the client observes function calls first and completion last.
      if (this.state.toolCalls.length > 0) {
        this.state.rawToolCallEvents.push(chunk);
        return {
          sseData: null,
          isToolCallChunk: true,
          isFinal: true,
        };
      }

      return {
        sseData: toSse(chunk),
        isToolCallChunk: false,
        isFinal: true,
      };
    }

    if (
      chunk.type === "response.failed" ||
      chunk.type === "response.incomplete"
    ) {
      this.state.stopReason = "length";
      return {
        sseData: toSse(chunk),
        isToolCallChunk: false,
        isFinal: true,
      };
    }

    return {
      sseData: toSse(chunk),
      isToolCallChunk: false,
      isFinal: false,
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
    const responseId = this.state.responseId || `resp_${Date.now()}`;
    const itemId = `msg_${Date.now()}`;

    return [
      toSse({
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: Date.now(),
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
        sequence_number: Date.now() + 1,
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
        sequence_number: Date.now() + 2,
        delta: text,
        logprobs: [],
      }),
      toSse({
        type: "response.output_text.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: Date.now() + 3,
        text,
        logprobs: [],
      }),
      toSse({
        type: "response.content_part.done",
        item_id: itemId,
        output_index: 0,
        content_index: 0,
        sequence_number: Date.now() + 4,
        part: {
          type: "output_text",
          text,
          annotations: [],
        },
      }),
      toSse({
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: Date.now() + 5,
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
        sequence_number: Date.now() + 6,
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
    return this.state.rawToolCallEvents.map((event) => toSse(event));
  }

  formatCompleteTextSSE(text: string): string[] {
    this.replacedText = text;
    return [this.formatTextDeltaSSE(text)];
  }

  formatToolCallsSSE(toolCalls: StreamAccumulatorState["toolCalls"]): string[] {
    // The upstream `response.completed` envelope has already been streamed and
    // it names the calls the model made directly. The client keeps the LAST
    // completed envelope, so the repair ends by re-issuing one that names the
    // rewritten calls — the same trick the refusal path relies on. That
    // envelope also becomes the persisted one, so the interaction log matches
    // what the client reconstructs.
    const base = this.completedResponse ?? this.toProviderResponse();
    const upstreamOutput = Array.isArray(base.output) ? base.output : [];
    const firstOutputIndex = upstreamOutput.filter(
      (item) => !isResponseNativeToolCall(item),
    ).length;
    let sequence = Date.now();
    const frames = formatResponsesFunctionCallFrames({
      toolCalls: toolCalls.map((call) => ({
        ...call,
        originalItem: Array.from(this.toolCallsByItemId.values()).find(
          (captured) => captured.id === call.id,
        )?.originalItem,
      })),
      firstOutputIndex,
      nextSequenceNumber: () => sequence++,
    });
    const rewritten = {
      ...base,
      output: rewriteResponsesOutput(upstreamOutput, toolCalls),
      usage: base.usage ?? toResponsesUsage(this.state.usage),
    } as unknown as OpenAiResponsesResponse;
    this.completedResponse = rewritten;
    frames.push(
      toSse({
        type: "response.completed",
        sequence_number: sequence++,
        response: rewritten,
      }),
    );
    return frames;
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): OpenAiResponsesResponse {
    if (
      this.replacedText === null &&
      this.completedResponse &&
      this.completedItems.size > 0 &&
      this.completedResponse.output.length === 0
    ) {
      return {
        ...this.completedResponse,
        output: Array.from(this.completedItems.values()),
      };
    }
    const outputItems: OpenAiResponsesResponse["output"] = [];

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
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
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
      const originals = new Map(
        Array.from(this.toolCallsByItemId.values()).map((call) => [
          call.id,
          call.originalItem,
        ]),
      );
      outputItems.push(
        ...(this.state.toolCalls.map((toolCall) => ({
          ...originals.get(toolCall.id),
          call_id: toolCall.id,
          type:
            originals.get(toolCall.id)?.type === "custom_tool_call"
              ? ("custom_tool_call" as const)
              : ("function_call" as const),
          name:
            (originals.get(toolCall.id) as { name?: string } | undefined)
              ?.name ?? toolCall.name,
          ...(originals.get(toolCall.id)?.type === "custom_tool_call"
            ? rewriteCustomToolCallArguments(toolCall.arguments)
            : { arguments: toolCall.arguments }),
          status: "completed" as const,
        })) as unknown as OpenAiResponsesResponse["output"]),
      );
    }

    // The upstream `response.completed` envelope is the richest record (it
    // echoes tools, reasoning config and the real ids), so it wins — but only
    // when it actually carries the turn. Reasoning turns finish with an empty
    // `output` even though the text arrived in `response.output_text.delta`
    // chunks; persisting that verbatim lost the whole assistant side of the
    // interaction, leaving LLM Logs with nothing to render. Keep the envelope
    // and restore the items we accumulated.
    if (this.replacedText === null && this.completedResponse) {
      const upstreamOutput = this.completedResponse.output;
      if (
        (Array.isArray(upstreamOutput) && upstreamOutput.length > 0) ||
        outputItems.length === 0
      ) {
        return this.completedResponse;
      }
      return { ...this.completedResponse, output: outputItems };
    }

    return {
      id: this.state.responseId || `resp_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.state.model,
      status: "completed",
      output: outputItems,
      usage: this.state.usage ? toResponsesUsage(this.state.usage) : undefined,
    } as unknown as OpenAiResponsesResponse;
  }

  private captureToolCallChunk(chunk: OpenAiResponsesStreamChunk): void {
    if (
      chunk.type === "response.output_item.added" ||
      chunk.type === "response.output_item.done"
    ) {
      const item = chunk.item;
      if (!isResponseNativeToolCall(item)) {
        return;
      }

      const callId = responseToolCallId(item);
      this.toolCallsByItemId.set(item.id ?? callId, {
        id: callId,
        name: codexToolName(item),
        arguments: responseToolCallArguments(item),
        originalItem: item as unknown as Record<string, unknown>,
      });
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

    if (chunk.type === "response.mcp_call_arguments.delta") {
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
    if (chunk.type === "response.mcp_call_arguments.done") {
      this.updateToolCallArguments(chunk);
    }
  }

  private updateToolCallArguments(
    chunk:
      | ResponseFunctionCallArgumentsDoneEvent
      | ResponseFunctionCallArgumentsDeltaEvent
      | ResponseMcpCallArgumentsDoneEvent
      | ResponseMcpCallArgumentsDeltaEvent,
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

    this.toolCallsByItemId.set(chunk.item_id, toolCall);
    this.state.toolCalls = Array.from(this.toolCallsByItemId.values());
  }
}

function createEmptyToolCompressionStats(): ToolCompressionStats {
  return {
    tokensBefore: 0,
    tokensAfter: 0,
    costSavings: 0,
    wasEffective: false,
    hadToolResults: false,
  };
}

function toCommonMessages(
  item: ResponseInputItem,
  toolCallsByCallId: Map<
    string,
    { name: string; arguments?: Record<string, unknown> }
  >,
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

  if (isResponsesToolOutputItem(item)) {
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
            arguments: toolCall?.arguments,
            content,
            isError: false,
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

function declaredResponsesMcpTools(tool: unknown): CommonMcpToolDefinition[] {
  if (
    !isRecord(tool) ||
    tool.type !== "mcp" ||
    typeof tool.server_label !== "string" ||
    !Array.isArray(tool.allowed_tools)
  ) {
    return [];
  }
  return tool.allowed_tools.flatMap((name) =>
    typeof name === "string"
      ? [
          {
            name: `mcp__${tool.server_label}__${name}`,
            inputSchema: {},
          },
        ]
      : [],
  );
}

type ResponsesToolItem = {
  type?: unknown;
  call_id?: unknown;
  name?: unknown;
  namespace?: unknown;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
  id?: unknown;
  server_label?: unknown;
};

function isResponsesToolOutputItem(
  item: unknown,
): item is ResponsesToolItem & { call_id: string; output: unknown } {
  return (
    isRecord(item) &&
    (item.type === "function_call_output" ||
      item.type === "custom_tool_call_output") &&
    typeof item.call_id === "string" &&
    "output" in item
  );
}

function isResponseMessage(
  item: ResponseOutputItem,
): item is Extract<ResponseOutputItem, { type: "message" }> {
  return item.type === "message";
}

function isResponseNativeToolCall(
  item: ResponseOutputItem | ResponsesToolItem,
): item is ResponsesToolItem & {
  type: "function_call" | "custom_tool_call";
  call_id?: string;
  id: string;
  name: string;
} {
  return (
    (item.type === "function_call" || item.type === "custom_tool_call") &&
    typeof item.call_id === "string" &&
    typeof item.name === "string"
  );
}

function isUnsupportedResponsesToolItem(item: unknown): boolean {
  if (isClientToolSearchCall(item)) return false;
  return (
    isRecord(item) &&
    typeof item.type === "string" &&
    /_call(?:_output)?$/.test(item.type) &&
    item.type !== "function_call" &&
    item.type !== "function_call_output" &&
    item.type !== "custom_tool_call" &&
    item.type !== "custom_tool_call_output"
  );
}

function isToolSearchCallBookkeeping(item: unknown): item is Record<
  string,
  unknown
> & {
  id: string;
  call_id: string;
  type: "tool_search_call";
  execution?: "client" | "server";
} {
  return (
    isRecord(item) &&
    item.type === "tool_search_call" &&
    typeof item.id === "string" &&
    typeof item.call_id === "string" &&
    "arguments" in item &&
    (item.execution === undefined ||
      item.execution === "client" ||
      item.execution === "server")
  );
}

function isClientToolSearchCall(
  item: unknown,
): item is Record<string, unknown> & { call_id: string } {
  return (
    isRecord(item) &&
    item.type === "tool_search_call" &&
    item.execution === "client" &&
    typeof item.id === "string" &&
    typeof item.call_id === "string" &&
    "arguments" in item
  );
}

function assertNoUnsupportedResponsesToolItems(
  items: readonly unknown[],
): void {
  const unsupported = items.find(isUnsupportedResponsesToolItem);
  if (unsupported) {
    throw unsupportedResponsesToolItemError(unsupported);
  }
}

/**
 * The Responses item is provider output, so do not expose its contents. The
 * type and field presence are sufficient to diagnose a protocol mismatch while
 * keeping unsupported calls fail-closed and retry-safe for client callers.
 */
function unsupportedResponsesToolItemError(item: unknown): ApiError {
  const value = isRecord(item) ? item : {};
  const type = typeof value.type === "string" ? value.type : "unknown";
  const fields = [
    "id",
    "call_id",
    "name",
    "namespace",
    "server_label",
    "execution",
    "arguments",
    "input",
    "output",
  ]
    .filter((field) => field in value)
    .sort();
  const execution =
    value.execution === "client" || value.execution === "server"
      ? `; execution: ${value.execution}`
      : "";
  return new ApiError(
    400,
    `Unsupported Responses tool item (${type}; fields: ${fields.join(",") || "none"}${execution}) cannot bypass policy`,
  );
}

/** Preserve Codex's namespace for policy and APPA registry lookup. */
export function codexToolName(item: {
  name: string;
  namespace?: unknown;
  server_label?: unknown;
}): string {
  if (typeof item.server_label === "string" && item.server_label.length > 0) {
    return `mcp__${item.server_label}__${item.name}`;
  }
  if (typeof item.namespace !== "string" || item.namespace.length === 0) {
    return item.name;
  }
  // Codex emits MCP calls as namespace + member. Gateway policy lookup uses
  // the canonical global MCP spelling rather than a dotted namespace.
  return item.namespace.startsWith("mcp__")
    ? `${item.namespace}__${item.name}`
    : `${item.namespace}.${item.name}`;
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
  | ResponseFunctionCallArgumentsDoneEvent {
  return (
    (chunk.type === "response.output_item.added" &&
      isResponseNativeToolCall(chunk.item)) ||
    (chunk.type === "response.output_item.done" &&
      isResponseNativeToolCall(chunk.item)) ||
    chunk.type === "response.function_call_arguments.delta" ||
    chunk.type === "response.function_call_arguments.done" ||
    chunk.type === "response.mcp_call_arguments.delta" ||
    chunk.type === "response.mcp_call_arguments.done"
  );
}

function getToolCallsByCallId(
  input: ResponseInputItem[],
): Map<string, { name: string; arguments?: Record<string, unknown> }> {
  return new Map(
    input.flatMap((item) => {
      if (!isResponseInputNativeToolCall(item)) {
        return [];
      }

      return [
        [
          item.call_id,
          {
            name: codexToolName(item),
            arguments: tryParseJsonObject(responseToolCallArguments(item)),
          },
        ] as const,
      ];
    }),
  );
}

function isResponseInputNativeToolCall(
  item: ResponseInputItem,
): item is ResponseInputItem &
  ResponsesToolItem & {
    call_id: string;
    name: string;
  } {
  const native = item as unknown as ResponsesToolItem;
  return (
    (native.type === "function_call" || native.type === "custom_tool_call") &&
    typeof native.call_id === "string" &&
    typeof native.name === "string"
  );
}

function responseToolCallArguments(item: ResponsesToolItem): string {
  if (typeof item.arguments === "string") return item.arguments;
  if (typeof item.input === "string")
    return JSON.stringify({ input: item.input });
  throw new Error(
    "Native Responses tool call has no supported argument payload",
  );
}

function responseToolCallId(item: ResponsesToolItem): string {
  if (typeof item.call_id === "string") return item.call_id;
  if (typeof item.id === "string") return item.id;
  throw new Error("Native Responses tool call has no stable id");
}

function rewriteCustomToolCallArguments(argumentsText: string) {
  let input: unknown;
  try {
    input = JSON.parse(argumentsText).input;
  } catch {
    throw new Error("Custom Responses tool call has invalid rewritten input");
  }
  if (typeof input !== "string") {
    throw new Error("Custom Responses tool call has no string rewritten input");
  }
  return { input };
}

function stringifyResponseToolOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output);
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
