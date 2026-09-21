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
import {
  getAzureOpenAiBearerTokenProvider,
  isAzureOpenAiEntraIdEnabled,
} from "@/clients/azure-openai-credentials";
import {
  buildAzureResponsesBaseUrl,
  normalizeAzureApiKey,
  shouldUseAzureOpenAiApiVersion,
} from "@/clients/azure-url";
import config from "@/config";
import { metrics } from "@/observability";
import type {
  Azure,
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
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import {
  ApiError,
  createStreamAccumulatorState,
  extractCommonToolCallArguments,
} from "@/types";
import { formatResponsesStreamErrorFrame } from "./responses-stream-error-frame";
import {
  formatResponsesFunctionCallFrames,
  namespaceOf,
  namespacesByCallId,
  rewriteResponsesOutput,
  toSse,
} from "./responses-tool-call-rewrite";
import { fromResponsesUsage, toResponsesUsage } from "./responses-usage";
import { PROXY_SDK_MAX_RETRIES } from "./sdk-retry-policy";

type AzureResponsesRequest = Azure.Types.ResponsesRequest;
type AzureResponsesResponse = Azure.Types.ResponsesResponse;
type AzureResponsesHeaders = Azure.Types.ChatCompletionsHeaders;
type AzureResponsesStreamChunk = Azure.Types.ResponseChunk;
type AzureResponseInput = string | ResponseInput | undefined;

type AzureFunctionToolDefinition = {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
};

export const azureResponsesAdapterFactory: LLMProvider<
  AzureResponsesRequest,
  AzureResponsesResponse,
  AzureResponseInput,
  AzureResponsesStreamChunk,
  AzureResponsesHeaders
> = {
  provider: "azure",
  interactionType: "azure:responses",

  // The Responses parser drops a chat-completions-shaped error frame as an
  // unknown chunk, turning an upstream failure into a blank turn.
  formatStreamErrorFrame: formatResponsesStreamErrorFrame,

  createRequestAdapter(
    request: AzureResponsesRequest,
  ): LLMRequestAdapter<AzureResponsesRequest, AzureResponseInput> {
    return new AzureResponsesRequestAdapter(request);
  },

  createResponseAdapter(
    response: AzureResponsesResponse,
  ): LLMResponseAdapter<AzureResponsesResponse> {
    return new AzureResponsesResponseAdapter(response);
  },

  createStreamAdapter():
    | LLMStreamAdapter<AzureResponsesStreamChunk, AzureResponsesResponse>
    | never {
    return new AzureResponsesStreamAdapter();
  },

  extractApiKey(headers: AzureResponsesHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.azure.baseUrl || undefined;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options: CreateClientOptions,
  ): OpenAIProvider {
    const resolvedBaseUrl = options.baseUrl
      ? buildAzureResponsesBaseUrl(options.baseUrl)
      : null;

    if (!resolvedBaseUrl) {
      throw new ApiError(
        500,
        "Azure AI Foundry base URL must include /openai or /openai/v1",
      );
    }

    const customFetch = options.agent
      ? metrics.llm.getObservableFetch("azure", options.agent, options.source)
      : undefined;

    if (!apiKey && isAzureOpenAiEntraIdEnabled()) {
      return new OpenAIProvider({
        maxRetries: PROXY_SDK_MAX_RETRIES,
        apiKey: getAzureOpenAiBearerTokenProvider(options.baseUrl),
        baseURL: resolvedBaseUrl,
        defaultQuery: getAzureResponsesDefaultQuery(options.baseUrl),
        fetch: customFetch,
        defaultHeaders: options.defaultHeaders,
      });
    }

    if (!apiKey) {
      throw new ApiError(401, "API key required for Azure AI Foundry");
    }

    const normalizedApiKey = normalizeAzureApiKey(apiKey);

    return new OpenAIProvider({
      maxRetries: PROXY_SDK_MAX_RETRIES,
      apiKey: normalizedApiKey,
      baseURL: resolvedBaseUrl,
      defaultQuery: getAzureResponsesDefaultQuery(options.baseUrl),
      fetch: customFetch,
      defaultHeaders: {
        ...options.defaultHeaders,
        "api-key": normalizedApiKey,
      },
    });
  },

  async execute(
    client: unknown,
    request: AzureResponsesRequest,
  ): Promise<AzureResponsesResponse> {
    const azureClient = client as OpenAIProvider;

    return (await azureClient.responses.create(
      request as ResponseCreateParamsNonStreaming,
    )) as unknown as AzureResponsesResponse;
  },

  async executeStream(
    client: unknown,
    request: AzureResponsesRequest,
  ): Promise<AsyncIterable<AzureResponsesStreamChunk>> {
    const azureClient = client as OpenAIProvider;

    return (await azureClient.responses.create({
      ...request,
      stream: true,
    } as ResponseCreateParamsStreaming)) as AsyncIterable<AzureResponsesStreamChunk>;
  },

  extractInternalCode(error: unknown): ArchestraInternalErrorCode | undefined {
    if (get(error, "error.code") === "context_length_exceeded") {
      return ArchestraInternalErrorCode.ContextLengthExceeded;
    }
    return undefined;
  },

  extractErrorMessage(error: unknown): string {
    return (
      get(error, "error.message") ??
      get(error, "message") ??
      "Internal server error"
    );
  },
};

function getAzureResponsesDefaultQuery(
  baseUrl: string | undefined,
): Record<string, string> | undefined {
  return shouldUseAzureOpenAiApiVersion(baseUrl)
    ? { "api-version": config.llm.azure.responsesApiVersion }
    : undefined;
}

class AzureResponsesRequestAdapter
  implements LLMRequestAdapter<AzureResponsesRequest, AzureResponseInput>
{
  readonly provider = "azure" as const;
  private request: AzureResponsesRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: AzureResponsesRequest) {
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

  getProviderMessages(): AzureResponseInput {
    return this.request.input;
  }

  getOriginalRequest(): AzureResponsesRequest {
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

  convertToolResultContent(input: AzureResponseInput): AzureResponseInput {
    // Azure Responses accepts tool results in their native function_call_output
    // shape, so the proxy should pass them through unchanged.
    return input;
  }

  toProviderRequest(): AzureResponsesRequest {
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

class AzureResponsesResponseAdapter
  implements LLMResponseAdapter<AzureResponsesResponse>
{
  readonly provider = "azure" as const;
  private response: AzureResponsesResponse;

  constructor(response: AzureResponsesResponse) {
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
          // Codex calls a namespaced tool by its bare name and names the
          // namespace beside it; the pair is which tool it called.
          ...namespaceOf(item),
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

  getOriginalResponse(): AzureResponsesResponse {
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
  ): AzureResponsesResponse {
    return {
      ...this.response,
      output: rewriteResponsesOutput(this.response.output, toolCalls),
    } as unknown as AzureResponsesResponse;
  }

  toRefusalResponse(
    refusalMessage: string,
    contentMessage: string,
  ): AzureResponsesResponse {
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
    } as unknown as AzureResponsesResponse;
  }
}

class AzureResponsesStreamAdapter
  implements LLMStreamAdapter<AzureResponsesStreamChunk, AzureResponsesResponse>
{
  readonly provider = "azure" as const;
  readonly state = createStreamAccumulatorState();
  private completedResponse: AzureResponsesResponse | null = null;
  private getTextSuffix: ((completedText: string) => string) | null = null;
  private textSuffix = "";
  private pendingTextTerminalEvents: AzureResponsesStreamChunk[] = [];
  private lastTextDelta: {
    itemId: string;
    outputIndex: number;
    contentIndex: number;
  } | null = null;
  private textByPart = new Map<string, string>();
  // Set to the refusal text when the streamed response was replaced by a policy
  // refusal, so toProviderResponse persists the refusal — not the captured
  // upstream completion or the blocked tool calls.
  private replacedText: string | null = null;
  private toolCallsByItemId = new Map<
    string,
    { id: string; name: string; arguments: string; namespace?: string }
  >();

  setTextSuffix(getSuffix: (completedText: string) => string): void {
    this.getTextSuffix = getSuffix;
  }

  processChunk(chunk: AzureResponsesStreamChunk): ChunkProcessingResult {
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
      return {
        sseData: `${pending}${toSse(chunk)}`,
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    if (this.getTextSuffix && this.isLastTextTerminalEvent(chunk)) {
      this.pendingTextTerminalEvents.push(chunk);
      return { sseData: null, isToolCallChunk: false, isFinal: false };
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
        chunk.response as unknown as AzureResponsesResponse;
      this.state.stopReason =
        this.state.toolCalls.length > 0 ? "tool_calls" : "stop";
      this.textSuffix = this.resolveTextSuffix();
      if (this.textSuffix) {
        return { sseData: null, isToolCallChunk: false, isFinal: true };
      }
      const pending = this.drainPendingTextTerminalEvents();

      if (this.state.toolCalls.length > 0) {
        this.state.rawToolCallEvents.push(chunk);
        return {
          sseData: pending || null,
          isToolCallChunk: true,
          isFinal: true,
        };
      }

      return {
        sseData: `${pending}${toSse(chunk)}`,
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
        sseData: `${this.drainPendingTextTerminalEvents()}${toSse(chunk)}`,
        isToolCallChunk: false,
        isFinal: true,
      };
    }

    return {
      sseData: `${this.drainPendingTextTerminalEvents()}${toSse(chunk)}`,
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
      // Codex routes a namespaced call by the namespace its item names.
      namespaceByCallId: namespacesByCallId({
        items: upstreamOutput,
        streamed: this.toolCallsByItemId.values(),
      }),
    });
    const rewritten = {
      ...base,
      output: rewriteResponsesOutput(upstreamOutput, toolCalls),
      usage: base.usage ?? toResponsesUsage(this.state.usage),
    } as unknown as AzureResponsesResponse;
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
    if (!this.textSuffix || !this.lastTextDelta) {
      return "data: [DONE]\n\n";
    }
    const textDelta = toSse({
      type: "response.output_text.delta",
      item_id: this.lastTextDelta.itemId,
      output_index: this.lastTextDelta.outputIndex,
      content_index: this.lastTextDelta.contentIndex,
      sequence_number: Date.now(),
      delta: this.textSuffix,
      logprobs: [],
    });
    const terminalEvents = this.pendingTextTerminalEvents
      .map((event) => toSse(this.appendSuffixToTerminalEvent(event)))
      .join("");
    this.pendingTextTerminalEvents = [];
    const response = this.appendSuffixToCompletedResponse(
      this.completedResponse ?? this.toProviderResponse(),
    );
    return `${textDelta}${terminalEvents}${toSse({
      type: "response.completed",
      sequence_number: Date.now() + 1,
      response,
    })}data: [DONE]\n\n`;
  }

  toProviderResponse(): AzureResponsesResponse {
    const outputItems: AzureResponsesResponse["output"] = [];

    const messageText = this.replacedText ?? this.state.text;
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
      } as AzureResponsesResponse["output"][number]);
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
    } as unknown as AzureResponsesResponse;
  }

  private resolveTextSuffix(): string {
    if (
      !this.getTextSuffix ||
      this.replacedText !== null ||
      this.state.toolCalls.length > 0 ||
      !this.lastTextDelta
    ) {
      return "";
    }
    const text = this.textByPart.get(this.textPartKey(this.lastTextDelta));
    return text ? this.getTextSuffix(text) : "";
  }

  private textPartKey(params: {
    itemId: string;
    outputIndex: number;
    contentIndex: number;
  }): string {
    return `${params.itemId}\u0000${params.outputIndex}\u0000${params.contentIndex}`;
  }

  private isLastTextTerminalEvent(chunk: AzureResponsesStreamChunk): boolean {
    const lastTextDelta = this.lastTextDelta;
    if (!lastTextDelta) return false;
    if (chunk.type === "response.output_text.done") {
      return (
        chunk.item_id === lastTextDelta.itemId &&
        chunk.output_index === lastTextDelta.outputIndex &&
        chunk.content_index === lastTextDelta.contentIndex
      );
    }
    if (chunk.type === "response.content_part.done") {
      return (
        chunk.item_id === lastTextDelta.itemId &&
        chunk.output_index === lastTextDelta.outputIndex &&
        chunk.content_index === lastTextDelta.contentIndex &&
        chunk.part.type === "output_text"
      );
    }
    return (
      chunk.type === "response.output_item.done" &&
      chunk.output_index === lastTextDelta.outputIndex &&
      chunk.item.type === "message" &&
      chunk.item.id === lastTextDelta.itemId &&
      chunk.item.content[lastTextDelta.contentIndex]?.type === "output_text"
    );
  }

  private drainPendingTextTerminalEvents(): string {
    const events = this.pendingTextTerminalEvents.map((event) => toSse(event));
    this.pendingTextTerminalEvents = [];
    return events.join("");
  }

  private appendSuffixToTerminalEvent(
    event: AzureResponsesStreamChunk,
  ): AzureResponsesStreamChunk {
    if (event.type === "response.output_text.done") {
      return { ...event, text: `${event.text}${this.textSuffix}` };
    }
    if (event.type === "response.content_part.done") {
      return {
        ...event,
        part: {
          ...(event.part as { type: string; text: string }),
          text: `${(event.part as { text: string }).text}${this.textSuffix}`,
        },
      } as AzureResponsesStreamChunk;
    }
    if (event.type === "response.output_item.done") {
      const contentIndex = this.lastTextDelta?.contentIndex;
      const item = event.item as {
        content: Array<{ type: string; text?: string }>;
      };
      return {
        ...event,
        item: {
          ...item,
          content: item.content.map((part, index) =>
            index === contentIndex &&
            part.type === "output_text" &&
            part.text !== undefined
              ? { ...part, text: `${part.text}${this.textSuffix}` }
              : part,
          ),
        },
      } as AzureResponsesStreamChunk;
    }
    return event;
  }

  private appendSuffixToCompletedResponse(
    response: AzureResponsesResponse,
  ): AzureResponsesResponse {
    const itemId = this.lastTextDelta?.itemId;
    const contentIndex = this.lastTextDelta?.contentIndex;
    return {
      ...response,
      output: response.output.map((item) => {
        if (item.type !== "message" || (itemId && item.id !== itemId)) {
          return item;
        }
        const message = item as {
          content: Array<{ type: string; text?: string }>;
        };
        return {
          ...item,
          content: message.content.map((part, index) =>
            item.id === itemId &&
            index === contentIndex &&
            part.type === "output_text" &&
            part.text !== undefined
              ? { ...part, text: `${part.text}${this.textSuffix}` }
              : part,
          ),
        };
      }),
    } as AzureResponsesResponse;
  }

  private captureToolCallChunk(chunk: AzureResponsesStreamChunk): void {
    if (chunk.type === "response.output_item.added") {
      const item = chunk.item;
      if (!isResponseFunctionCall(item)) {
        return;
      }

      this.toolCallsByItemId.set(item.id ?? item.call_id, {
        id: item.call_id,
        name: item.name,
        arguments: item.arguments,
        ...namespaceOf(item),
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
            ...(toolCall?.namespace ? { namespace: toolCall.namespace } : {}),
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
): tool is AzureFunctionToolDefinition {
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
