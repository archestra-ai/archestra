import { ArchestraInternalErrorCode } from "@archestra/shared";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
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
import {
  ApiError,
  createStreamAccumulatorState,
  extractCommonToolCallArguments,
} from "@/types";
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
type OpenAiResponsesHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiResponsesStreamChunk = OpenAi.Types.ResponseChunk;
type OpenAiResponseInput = string | ResponseInput | undefined;

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
          arguments: toolCall?.arguments,
          content: item.output,
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

        const updatedOutput = this.toolResultUpdates[item.call_id];
        if (!updatedOutput) {
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
    return this.response.output.flatMap((item) => {
      if (!isResponseFunctionCall(item)) {
        return [];
      }

      return [
        {
          id: item.call_id,
          name: item.name,
          arguments: tryParseJsonObject(item.arguments),
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

class OpenAiResponsesStreamAdapter
  implements
    LLMStreamAdapter<OpenAiResponsesStreamChunk, OpenAiResponsesResponse>
{
  readonly provider = "openai" as const;
  readonly state = createStreamAccumulatorState();
  private completedResponse: OpenAiResponsesResponse | null = null;
  // Set to the refusal text when the streamed response was replaced by a policy
  // refusal, so toProviderResponse persists the refusal — not the captured
  // upstream completion or the blocked tool calls.
  private replacedText: string | null = null;
  private toolCallsByItemId = new Map<
    string,
    { id: string; name: string; arguments: string }
  >();

  processChunk(chunk: OpenAiResponsesStreamChunk): ChunkProcessingResult {
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
      (item) => item.type !== "function_call",
    ).length;
    let sequence = Date.now();
    const frames = formatResponsesFunctionCallFrames({
      toolCalls,
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
      outputItems.push(
        ...this.state.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          call_id: toolCall.id,
          type: "function_call" as const,
          name: toolCall.name,
          arguments: toolCall.arguments,
          status: "completed" as const,
        })),
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
    if (chunk.type === "response.output_item.added") {
      const item = chunk.item;
      if (!isResponseFunctionCall(item)) {
        return;
      }

      this.toolCallsByItemId.set(item.id ?? item.call_id, {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
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

  if (item.type === "function_call_output") {
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

function isFunctionCallOutputItem(
  item: unknown,
): item is Extract<ResponseInputItem, { type: "function_call_output" }> {
  return (
    !!item &&
    typeof item === "object" &&
    "type" in item &&
    item.type === "function_call_output"
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
  | ResponseFunctionCallArgumentsDoneEvent {
  return (
    (chunk.type === "response.output_item.added" &&
      isResponseFunctionCall(chunk.item)) ||
    (chunk.type === "response.output_item.done" &&
      isResponseFunctionCall(chunk.item)) ||
    chunk.type === "response.function_call_arguments.delta" ||
    chunk.type === "response.function_call_arguments.done"
  );
}

function getToolCallsByCallId(
  input: ResponseInputItem[],
): Map<string, { name: string; arguments?: Record<string, unknown> }> {
  return new Map(
    input.flatMap((item) => {
      if (!isResponseInputFunctionCall(item)) {
        return [];
      }

      return [
        [
          item.call_id,
          {
            name: item.name,
            arguments: extractCommonToolCallArguments(item.arguments),
          },
        ] as const,
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
