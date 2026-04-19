/**
 * Unified LLM Gateway — Responses API Adapter
 *
 * Bridges the OpenAI Responses API format (used by Azure AI Foundry and the
 * Realtime API) to the Chat Completions format consumed by every upstream
 * provider in the unified gateway.  Converts requests on the way in and
 * normalises responses back to Responses API format on the way out.
 */
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
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { type Azure, createStreamAccumulatorState, type OpenAi } from "@/types";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type OAIRequest = OpenAi.Types.ChatCompletionsRequest;
type OAIResponse = OpenAi.Types.ChatCompletionsResponse;
type OAIChunk = OpenAi.Types.ChatCompletionChunk;

type InnerAdapter = LLMProvider<
  OAIRequest,
  OAIResponse,
  unknown[],
  unknown,
  unknown
>;

type ResponsesRequest = Azure.Types.ResponsesRequest;
type ResponsesResponse = Azure.Types.ResponsesResponse;

type ResponsesInputItem = {
  type: string;
  role?: string;
  content?: unknown;
  call_id?: string;
  output?: unknown;
  [key: string]: unknown;
};

type ResponsesFunctionTool = {
  type: "function";
  name: string;
  description?: string | null;
  parameters?: Record<string, unknown> | null;
};

// =============================================================================
// PUBLIC API
// =============================================================================

export function buildUnifiedResponsesAdapter(
  innerAdapter: InnerAdapter,
): LLMProvider<
  ResponsesRequest,
  ResponsesResponse,
  unknown[],
  unknown,
  unknown
> {
  return {
    provider: innerAdapter.provider,
    interactionType: innerAdapter.interactionType,
    spanName: innerAdapter.spanName,

    createRequestAdapter(
      request: ResponsesRequest,
    ): LLMRequestAdapter<ResponsesRequest, unknown[]> {
      return new UnifiedResponsesRequestAdapter(request);
    },

    createResponseAdapter(
      response: ResponsesResponse,
    ): LLMResponseAdapter<ResponsesResponse> {
      return new UnifiedResponsesResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<unknown, ResponsesResponse> {
      return new UnifiedResponsesStreamAdapter() as LLMStreamAdapter<
        unknown,
        ResponsesResponse
      >;
    },

    extractApiKey(headers: unknown): string | undefined {
      return innerAdapter.extractApiKey(headers as never);
    },

    getBaseUrl(): string | undefined {
      return innerAdapter.getBaseUrl();
    },

    createClient(
      apiKey: string | undefined,
      options: CreateClientOptions,
    ): unknown {
      return innerAdapter.createClient(apiKey, options);
    },

    async execute(
      client: unknown,
      request: ResponsesRequest,
    ): Promise<ResponsesResponse> {
      const chatRequest = responsesToChatCompletions(request);
      const chatResponse = await innerAdapter.execute(
        client,
        chatRequest as OAIRequest,
      );
      return chatCompletionsToResponses(chatResponse as OAIResponse, request);
    },

    async executeStream(
      client: unknown,
      request: ResponsesRequest,
    ): Promise<AsyncIterable<unknown>> {
      const chatRequest = responsesToChatCompletions(request);
      return innerAdapter.executeStream(client, chatRequest as OAIRequest);
    },

    extractErrorMessage(error: unknown): string {
      return innerAdapter.extractErrorMessage(error);
    },
  };
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class UnifiedResponsesRequestAdapter
  implements LLMRequestAdapter<ResponsesRequest, unknown[]>
{
  readonly provider = "unified" as const;
  private request: ResponsesRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: ResponsesRequest) {
    this.request = request;
  }

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return this.request.stream === true;
  }

  getMessages(): CommonMessage[] {
    const messages: CommonMessage[] = [];

    if (this.request.instructions) {
      messages.push({ role: "system", content: this.request.instructions });
    }

    if (typeof this.request.input === "string") {
      messages.push({ role: "user", content: this.request.input });
      return messages;
    }

    if (Array.isArray(this.request.input)) {
      for (const item of this.request.input as ResponsesInputItem[]) {
        const isMessage =
          item.type === "message" ||
          (item.type == null && typeof item.role === "string");

        if (isMessage) {
          messages.push({
            role: (item.role as CommonMessage["role"]) ?? "user",
            content: extractInputText(item.content),
          });
        }
      }
    }

    return messages;
  }

  getToolResults(): CommonToolResult[] {
    if (!Array.isArray(this.request.input)) {
      return [];
    }

    const toolNamesByCallId = getToolNamesByCallId(
      this.request.input as ResponsesInputItem[],
    );

    return (this.request.input as ResponsesInputItem[]).flatMap((item) => {
      if (item.type !== "function_call_output" || !item.call_id) {
        return [];
      }

      return [
        {
          id: item.call_id,
          name: toolNamesByCallId.get(item.call_id) ?? "unknown",
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output),
          isError: false,
        },
      ];
    });
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!Array.isArray(this.request.tools)) {
      return [];
    }

    return (this.request.tools as unknown[]).flatMap((tool) => {
      const t = tool as ResponsesFunctionTool;
      if (t.type !== "function") {
        return [];
      }

      return [
        {
          name: t.name,
          description: t.description ?? undefined,
          inputSchema: t.parameters ?? {},
        },
      ];
    });
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): unknown[] {
    return this.getMessages() as unknown[];
  }

  getOriginalRequest(): ResponsesRequest {
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
    return createEmptyToolCompressionStats();
  }

  convertToolResultContent(input: unknown[]): unknown[] {
    return input;
  }

  toProviderRequest(): ResponsesRequest {
    if (
      !Array.isArray(this.request.input) ||
      Object.keys(this.toolResultUpdates).length === 0
    ) {
      return {
        ...this.request,
        model: this.getModel(),
      };
    }

    return {
      ...this.request,
      model: this.getModel(),
      input: (this.request.input as ResponsesInputItem[]).map((item) => {
        if (item.type !== "function_call_output" || !item.call_id) {
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
      }) as unknown as ResponsesRequest["input"],
    };
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class UnifiedResponsesResponseAdapter
  implements LLMResponseAdapter<ResponsesResponse>
{
  readonly provider = "unified" as const;
  private response: ResponsesResponse;

  constructor(response: ResponsesResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    return this.response.model;
  }

  getText(): string {
    return (this.response.output ?? [])
      .flatMap((item) => {
        const it = item as { type: string; content?: unknown[] };
        if (it.type !== "message" || !Array.isArray(it.content)) {
          return [];
        }

        return it.content.flatMap((part) => {
          const p = part as { type: string; text?: string };
          if (p.type === "output_text" && p.text) {
            return [p.text];
          }
          return [];
        });
      })
      .join("\n");
  }

  getToolCalls(): CommonToolCall[] {
    return (this.response.output ?? []).flatMap((item) => {
      const it = item as {
        type: string;
        call_id?: string;
        name?: string;
        arguments?: string;
      };

      if (it.type !== "function_call" || !it.call_id || !it.name) {
        return [];
      }

      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(it.arguments ?? "{}");
      } catch {
        parsedArgs = {};
      }

      return [{ id: it.call_id, name: it.name, arguments: parsedArgs }];
    });
  }

  hasToolCalls(): boolean {
    return this.getToolCalls().length > 0;
  }

  getUsage(): UsageView {
    const usage = this.response.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    return {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
    };
  }

  getOriginalResponse(): ResponsesResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    if (this.hasToolCalls()) {
      return ["tool_calls"];
    }
    return ["completed"];
  }

  toRefusalResponse(
    refusalMessage: string,
    _contentMessage: string,
  ): ResponsesResponse {
    return {
      id: this.response.id,
      object: "response" as const,
      created_at: Math.floor(Date.now() / 1000),
      model: this.response.model,
      status: "completed",
      output: [
        {
          id: `msg_${Date.now()}`,
          type: "message" as const,
          role: "assistant" as const,
          status: "completed",
          content: [{ type: "refusal" as const, refusal: refusalMessage }],
        },
      ],
      usage: this.response.usage,
    } as unknown as ResponsesResponse;
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class UnifiedResponsesStreamAdapter
  implements LLMStreamAdapter<OAIChunk, ResponsesResponse>
{
  readonly provider = "unified" as const;
  readonly state = createStreamAccumulatorState();
  private itemId = `msg_${Date.now()}`;

  processChunk(chunk: OAIChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    if (!this.state.responseId && chunk.id) {
      this.state.responseId = chunk.id;
    }

    if (chunk.model) {
      this.state.model = chunk.model;
    }

    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const delta = chunk.choices?.[0]?.delta;
    if (!delta) {
      if (this.state.usage !== null && this.state.stopReason !== null) {
        return {
          sseData: toSse({
            type: "response.completed",
            response: this.toProviderResponse(),
          }),
          isToolCallChunk: false,
          isFinal: true,
        };
      }
      return { sseData: null, isToolCallChunk: false, isFinal: false };
    }

    if (delta.content) {
      this.state.text += delta.content;
      return {
        sseData: toSse({
          type: "response.output_text.delta",
          delta: delta.content,
        }),
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    if (delta.tool_calls?.length) {
      const tc = delta.tool_calls[0];
      if (tc && tc.type === "function") {
        const existing = this.state.toolCalls.find(
          (t) => t.id === (tc.id ?? ""),
        );
        if (!existing && tc.id) {
          this.state.toolCalls.push({
            id: tc.id,
            name: tc.function?.name ?? "",
            arguments: tc.function?.arguments ?? "",
          });
        } else if (existing && tc.function?.arguments) {
          existing.arguments += tc.function.arguments;
        }
      }
      return { sseData: null, isToolCallChunk: true, isFinal: false };
    }

    const finishReason = chunk.choices?.[0]?.finish_reason;
    if (finishReason) {
      this.state.stopReason =
        this.state.toolCalls.length > 0 ? "tool_calls" : "stop";
      if (this.state.usage !== null) {
        return {
          sseData: toSse({
            type: "response.completed",
            response: this.toProviderResponse(),
          }),
          isToolCallChunk: false,
          isFinal: true,
        };
      }
    }

    return { sseData: null, isToolCallChunk: false, isFinal: false };
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
    return [
      toSse({
        type: "response.output_item.added",
        output_index: 0,
        item: {
          id: this.itemId,
          type: "message",
          role: "assistant",
          status: "in_progress",
          content: [],
        },
      }),
      toSse({
        type: "response.content_part.added",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      }),
      toSse({
        type: "response.output_text.delta",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        delta: text,
      }),
      toSse({
        type: "response.output_text.done",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        text,
      }),
      toSse({
        type: "response.content_part.done",
        item_id: this.itemId,
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }),
      toSse({
        type: "response.output_item.done",
        output_index: 0,
        item: {
          id: this.itemId,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      }),
      toSse({
        type: "response.completed",
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          model: this.state.model,
          status: "completed",
          output: [
            {
              id: this.itemId,
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        },
      }),
    ].join("");
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map((e) => toSse(e));
  }

  formatCompleteTextSSE(text: string): string[] {
    return [this.formatTextDeltaSSE(text)];
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  toProviderResponse(): ResponsesResponse {
    const output: ResponsesResponse["output"] = [];

    if (this.state.text) {
      output.push({
        id: this.itemId,
        type: "message" as const,
        role: "assistant" as const,
        status: "completed",
        content: [
          {
            type: "output_text" as const,
            text: this.state.text,
            annotations: [],
          },
        ],
      } as ResponsesResponse["output"][number]);
    }

    output.push(
      ...this.state.toolCalls.map((tc) => ({
        type: "function_call" as const,
        id: tc.id,
        call_id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
        status: "completed" as const,
      })),
    );

    return {
      id: this.state.responseId || `resp_${Date.now()}`,
      object: "response" as const,
      created_at: Math.floor(Date.now() / 1000),
      model: this.state.model,
      status: "completed",
      output,
      usage: this.state.usage
        ? {
            input_tokens: this.state.usage.inputTokens,
            output_tokens: this.state.usage.outputTokens,
            total_tokens:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          }
        : undefined,
    } as unknown as ResponsesResponse;
  }
}

// =============================================================================
// INTERNAL HELPERS
// =============================================================================

function responsesToChatCompletions(request: ResponsesRequest): OAIRequest {
  const messages: OAIRequest["messages"] = [];

  if (request.instructions) {
    messages.push({ role: "system", content: request.instructions });
  }

  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
  } else if (Array.isArray(request.input)) {
    for (const item of request.input as ResponsesInputItem[]) {
      const isMessage =
        item.type === "message" ||
        (!item.type && typeof item.role === "string");

      if (isMessage) {
        messages.push({
          role: (item.role ?? "user") as "user" | "assistant" | "system",
          content: extractInputText(item.content),
        } as OAIRequest["messages"][number]);
      } else if (item.type === "function_call_output" && item.call_id) {
        messages.push({
          role: "tool",
          tool_call_id: item.call_id,
          content:
            typeof item.output === "string"
              ? item.output
              : JSON.stringify(item.output),
        } as OAIRequest["messages"][number]);
      }
    }
  }

  const tools = (request.tools as unknown[] | undefined)
    ?.filter(
      (t): t is ResponsesFunctionTool =>
        (t as ResponsesFunctionTool).type === "function",
    )
    .map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? undefined,
        parameters: t.parameters ?? {},
      },
    }));

  return {
    model: request.model,
    messages,
    temperature: request.temperature ?? undefined,
    max_tokens: request.max_output_tokens ?? undefined,
    stream: false,
    tools: tools?.length ? tools : undefined,
    tool_choice:
      (request.tool_choice as OAIRequest["tool_choice"]) ?? undefined,
    user: request.user,
  } as OAIRequest;
}

function chatCompletionsToResponses(
  chatResponse: OAIResponse,
  originalRequest: ResponsesRequest,
): ResponsesResponse {
  const choice = chatResponse.choices?.[0];
  const output: ResponsesResponse["output"] = [];
  const itemId = `msg_${Date.now()}`;

  if (choice?.message?.content) {
    output.push({
      id: itemId,
      type: "message" as const,
      role: "assistant" as const,
      status: "completed",
      content: [
        {
          type: "output_text" as const,
          text: choice.message.content,
          annotations: [],
        },
      ],
    } as ResponsesResponse["output"][number]);
  }

  const toolCalls = choice?.message?.tool_calls ?? [];
  for (const tc of toolCalls) {
    if (tc.type !== "function") continue;
    output.push({
      type: "function_call" as const,
      id: tc.id,
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: "completed" as const,
    } as ResponsesResponse["output"][number]);
  }

  const usage = chatResponse.usage;

  return {
    id: `resp_${chatResponse.id?.replace("chatcmpl-", "") ?? Date.now()}`,
    object: "response" as const,
    created_at: chatResponse.created ?? Math.floor(Date.now() / 1000),
    model: chatResponse.model ?? originalRequest.model,
    status: "completed",
    output,
    usage: usage
      ? {
          input_tokens: usage.prompt_tokens,
          output_tokens: usage.completion_tokens,
          total_tokens: usage.total_tokens,
        }
      : undefined,
  } as unknown as ResponsesResponse;
}

function extractInputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .flatMap((part) => {
      if (typeof part === "string") {
        return [part];
      }
      const p = part as { type?: string; text?: string };
      if (
        (p.type === "input_text" ||
          p.type === "output_text" ||
          p.type === "text") &&
        typeof p.text === "string"
      ) {
        return [p.text];
      }
      if (typeof p.text === "string") {
        return [p.text];
      }
      return [];
    })
    .join("\n");
}

function toSse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
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

/**
 * Build a map of call_id → tool name by scanning for function_call items
 * that precede their corresponding function_call_output items.
 */
function getToolNamesByCallId(
  items: ResponsesInputItem[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (const item of items) {
    if (
      item.type === "function_call" &&
      typeof item.call_id === "string" &&
      typeof item.name === "string"
    ) {
      map.set(item.call_id, item.name);
    }
  }
  return map;
}
