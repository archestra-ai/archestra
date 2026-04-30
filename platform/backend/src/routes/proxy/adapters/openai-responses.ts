import { ArchestraInternalErrorCode } from "@shared";
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
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { ApiError, createStreamAccumulatorState } from "@/types";

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

    const resolvedBaseUrl = options.baseUrl || config.llm.openai.baseUrl;

    const customFetch = options.agent
      ? metrics.llm.getObservableFetch(
          "openai",
          options.agent,
          options.source,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
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

    return this.request.input.flatMap((item) => toCommonMessages(item));
  }

  getToolResults(): CommonToolResult[] {
    if (!Array.isArray(this.request.input)) {
      return [];
    }

    const toolNamesByCallId = getToolNamesByCallId(this.request.input);

    return this.request.input.flatMap((item) => {
      if (!isFunctionCallOutputItem(item)) {
        return [];
      }

      return [
        {
          id: item.call_id,
          name: toolNamesByCallId.get(item.call_id) ?? "unknown",
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
    return {
      inputTokens: this.response.usage?.input_tokens ?? 0,
      outputTokens: this.response.usage?.output_tokens ?? 0,
    };
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
        this.state.usage = {
          inputTokens: chunk.response.usage.input_tokens ?? 0,
          outputTokens: chunk.response.usage.output_tokens ?? 0,
        };
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
          usage: {
            input_tokens: 0,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 0,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: 0,
          },
        },
      }),
    ].join("");
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map((event) => toSse(event));
  }

  formatCompleteTextSSE(text: string): string[] {
    return [this.formatTextDeltaSSE(text)];
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): OpenAiResponsesResponse {
    if (this.completedResponse) {
      return this.completedResponse;
    }

    const outputItems: OpenAiResponsesResponse["output"] = [];

    if (this.state.text) {
      outputItems.push({
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: this.state.text,
            annotations: [],
          },
        ],
      } as OpenAiResponsesResponse["output"][number]);
    }

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

    return {
      id: this.state.responseId || `resp_${Date.now()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      model: this.state.model,
      status: "completed",
      output: outputItems,
      usage: this.state.usage
        ? {
            input_tokens: this.state.usage.inputTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: this.state.usage.outputTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          }
        : undefined,
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

function toCommonMessages(item: ResponseInputItem): CommonMessage[] {
  if (item.type === "message") {
    return [
      {
        role: normalizeResponseMessageRole(item.role),
        content: extractResponseInputText(item.content),
      },
    ];
  }

  if (item.type === "function_call_output") {
    return [
      {
        role: "tool",
        content:
          typeof item.output === "string"
            ? item.output
            : JSON.stringify(item.output),
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

function toSse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function getToolNamesByCallId(input: ResponseInputItem[]): Map<string, string> {
  return new Map(
    input.flatMap((item) => {
      if (!isResponseInputFunctionCall(item)) {
        return [];
      }

      return [[item.call_id, item.name] as const];
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
