import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  Cohere,
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
  ToonCompressionResult,
  UsageView,
} from "@/types";
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;
type CohereMessages = Cohere.Types.ChatRequest["messages"];
type CohereHeaders = Cohere.Types.ChatHeaders;

// Cohere streaming event types
interface CohereStreamChunk {
  type:
    | "message-start"
    | "content-start"
    | "content-delta"
    | "content-end"
    | "tool-plan-delta"
    | "tool-call-start"
    | "tool-call-delta"
    | "tool-call-end"
    | "message-end";
  index?: number;
  id?: string;
  delta?: {
    message?: {
      role?: string;
      content?: Array<{ type: string; text?: string }>;
      tool_calls?: Array<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
      tool_plan?: string;
    };
  };
  usage?: {
    billed_units?: { input_tokens?: number; output_tokens?: number };
    tokens?: { input_tokens?: number; output_tokens?: number };
  };
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class CohereRequestAdapter
  implements LLMRequestAdapter<CohereRequest, CohereMessages>
{
  readonly provider = "cohere" as const;
  private request: CohereRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: CohereRequest) {
    this.request = request;
  }

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  getModel(): string {
    return this.modifiedModel ?? this.request.model;
  }

  isStreaming(): boolean {
    return this.request.stream === true;
  }

  getMessages(): CommonMessage[] {
    return this.toCommonFormat(this.request.messages);
  }

  getToolResults(): CommonToolResult[] {
    const results: CommonToolResult[] = [];

    for (const message of this.request.messages) {
      if (message.role === "tool") {
        // Find tool name from previous assistant messages
        const toolName = this.findToolName(message.tool_call_id);

        let content: unknown;
        if (typeof message.content === "string") {
          try {
            content = JSON.parse(message.content);
          } catch {
            content = message.content;
          }
        } else {
          content = message.content;
        }

        results.push({
          id: message.tool_call_id,
          name: toolName ?? "unknown",
          content,
          isError: false,
        });
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.tools) return [];

    const result: CommonMcpToolDefinition[] = [];
    for (const tool of this.request.tools) {
      if (tool.type === "function" && tool.function) {
        result.push({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: tool.function.parameters ?? {},
        });
      }
    }
    return result;
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): CohereMessages {
    return this.request.messages;
  }

  getOriginalRequest(): CohereRequest {
    return this.request;
  }

  // ---------------------------------------------------------------------------
  // Modify Access
  // ---------------------------------------------------------------------------

  setModel(model: string): void {
    this.modifiedModel = model;
  }

  updateToolResult(toolCallId: string, newContent: string): void {
    this.toolResultUpdates[toolCallId] = newContent;
  }

  applyToolResultUpdates(updates: Record<string, string>): void {
    Object.assign(this.toolResultUpdates, updates);
  }

  async applyToonCompression(model: string): Promise<ToonCompressionResult> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    // Update internal messages state
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return {
      tokensBefore: stats.toonTokensBefore,
      tokensAfter: stats.toonTokensAfter,
      costSavings: stats.toonCostSavings,
    };
  }

  convertToolResultContent(messages: CohereMessages): CohereMessages {
    // Cohere doesn't have MCP image block conversion like Anthropic
    // Just return messages as-is for now
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): CohereRequest {
    let messages = this.request.messages;

    // Apply tool result updates if any
    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = this.applyUpdates(messages, this.toolResultUpdates);
    }

    return {
      ...this.request,
      model: this.getModel(),
      messages,
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private findToolName(toolCallId: string): string | null {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];
      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.id === toolCallId) {
            return toolCall.function.name;
          }
        }
      }
    }
    return null;
  }

  private toCommonFormat(messages: CohereMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[CohereAdapter] toCommonFormat: starting conversion",
    );
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role === "tool" ? "user" : (message.role as CommonMessage["role"]),
      };

      // Handle tool messages that contain tool results
      if (message.role === "tool") {
        const toolName = this.findToolNameInMessages(
          messages,
          message.tool_call_id,
        );

        if (toolName) {
          let toolResult: unknown;
          if (typeof message.content === "string") {
            try {
              toolResult = JSON.parse(message.content);
            } catch {
              toolResult = message.content;
            }
          } else {
            toolResult = message.content;
          }

          commonMessage.toolCalls = [
            {
              id: message.tool_call_id,
              name: toolName,
              content: toolResult,
              isError: false,
            },
          ];
        }
      }

      commonMessages.push(commonMessage);
    }

    logger.debug(
      { inputCount: messages.length, outputCount: commonMessages.length },
      "[CohereAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  private findToolNameInMessages(
    messages: CohereMessages,
    toolCallId: string,
  ): string | null {
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
    return null;
  }

  private applyUpdates(
    messages: CohereMessages,
    updates: Record<string, string>,
  ): CohereMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[CohereAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[CohereAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      if (message.role === "tool" && updates[message.tool_call_id]) {
        appliedCount++;
        logger.debug(
          { toolCallId: message.tool_call_id },
          "[CohereAdapter] applyUpdates: applying update to tool result",
        );
        return {
          ...message,
          content: updates[message.tool_call_id],
        };
      }
      return message;
    });

    logger.debug(
      { updateCount, appliedCount },
      "[CohereAdapter] applyUpdates: complete",
    );
    return result;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class CohereResponseAdapter implements LLMResponseAdapter<CohereResponse> {
  readonly provider = "cohere" as const;
  private response: CohereResponse;

  constructor(response: CohereResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    // Cohere response doesn't include model in response, return empty
    return "";
  }

  getText(): string {
    if (!this.response.message?.content) {
      return "";
    }
    const textBlocks = this.response.message.content.filter(
      (block) => block.type === "text",
    );
    return textBlocks.map((block) => block.text ?? "").join("");
  }

  getToolCalls(): CommonToolCall[] {
    if (!this.response.message?.tool_calls) {
      return [];
    }
    return this.response.message.tool_calls.map((toolCall) => {
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = JSON.parse(toolCall.function.arguments);
      } catch {
        // Keep empty object if parse fails
      }
      return {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: parsedArgs,
      };
    });
  }

  hasToolCalls(): boolean {
    return (this.response.message?.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    const tokens = this.response.usage?.tokens ?? this.response.usage?.billed_units;
    return {
      inputTokens: tokens?.input_tokens ?? 0,
      outputTokens: tokens?.output_tokens ?? 0,
    };
  }

  getOriginalResponse(): CohereResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): CohereResponse {
    return {
      ...this.response,
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: contentMessage,
          },
        ],
        tool_calls: undefined,
      },
      finish_reason: "COMPLETE",
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class CohereStreamAdapter
  implements LLMStreamAdapter<CohereStreamChunk, CohereResponse>
{
  readonly provider = "cohere" as const;
  readonly state: StreamAccumulatorState;
  private currentToolCallIndex = -1;

  constructor() {
    this.state = {
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

  processChunk(chunk: CohereStreamChunk): ChunkProcessingResult {
    // Track first chunk time
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    switch (chunk.type) {
      case "message-start":
        if (chunk.id) {
          this.state.responseId = chunk.id;
        }
        sseData = `event: message-start\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "content-start":
        sseData = `event: content-start\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "content-delta":
        if (chunk.delta?.message?.content) {
          for (const content of chunk.delta.message.content) {
            if (content.type === "text" && content.text) {
              this.state.text += content.text;
            }
          }
        }
        sseData = `event: content-delta\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "content-end":
        sseData = `event: content-end\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "tool-plan-delta":
        // Tool plan is just reasoning, stream it
        sseData = `event: tool-plan-delta\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "tool-call-start":
        this.currentToolCallIndex = this.state.toolCalls.length;
        if (chunk.delta?.message?.tool_calls?.[0]) {
          const toolCall = chunk.delta.message.tool_calls[0];
          this.state.toolCalls.push({
            id: toolCall.id ?? `tool-${this.currentToolCallIndex}`,
            name: toolCall.function?.name ?? "",
            arguments: "",
          });
        }
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
        break;

      case "tool-call-delta":
        if (
          this.currentToolCallIndex >= 0 &&
          chunk.delta?.message?.tool_calls?.[0]?.function?.arguments
        ) {
          this.state.toolCalls[this.currentToolCallIndex].arguments +=
            chunk.delta.message.tool_calls[0].function.arguments;
        }
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
        break;

      case "tool-call-end":
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
        break;

      case "message-end":
        if (chunk.delta?.message) {
          // Extract final message details if present
        }
        if (chunk.usage) {
          const tokens = chunk.usage.tokens ?? chunk.usage.billed_units;
          this.state.usage = {
            inputTokens: tokens?.input_tokens ?? 0,
            outputTokens: tokens?.output_tokens ?? 0,
          };
        }
        this.state.stopReason = "COMPLETE";
        isFinal = true;
        break;
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "request-id": `req-proxy-${Date.now()}`,
    };
  }

  formatTextDeltaSSE(text: string): string {
    const event = {
      type: "content-delta",
      index: 0,
      delta: {
        message: {
          content: [{ type: "text", text }],
        },
      },
    };
    return `event: content-delta\ndata: ${JSON.stringify(event)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  formatCompleteTextSSE(text: string): string[] {
    return [
      `event: content-start\ndata: ${JSON.stringify({
        type: "content-start",
        index: 0,
      })}\n\n`,
      `event: content-delta\ndata: ${JSON.stringify({
        type: "content-delta",
        index: 0,
        delta: {
          message: {
            content: [{ type: "text", text }],
          },
        },
      })}\n\n`,
      `event: content-end\ndata: ${JSON.stringify({
        type: "content-end",
        index: 0,
      })}\n\n`,
    ];
  }

  formatEndSSE(): string {
    const events: string[] = [];

    events.push(
      `event: message-end\ndata: ${JSON.stringify({
        type: "message-end",
        delta: {
          finish_reason: this.state.stopReason ?? "COMPLETE",
        },
        usage: {
          tokens: {
            input_tokens: this.state.usage?.inputTokens ?? 0,
            output_tokens: this.state.usage?.outputTokens ?? 0,
          },
        },
      })}\n\n`,
    );

    return events.join("");
  }

  toProviderResponse(): CohereResponse {
    const content: CohereResponse["message"]["content"] = [];

    // Add text content if we have text
    if (this.state.text) {
      content.push({
        type: "text",
        text: this.state.text,
      });
    }

    // Build tool_calls array
    const toolCalls: CohereResponse["message"]["tool_calls"] = [];
    for (const toolCall of this.state.toolCalls) {
      toolCalls.push({
        id: toolCall.id,
        type: "function",
        function: {
          name: toolCall.name,
          arguments: toolCall.arguments,
        },
      });
    }

    return {
      id: this.state.responseId,
      message: {
        role: "assistant",
        content: content.length > 0 ? content : undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      },
      finish_reason: (this.state.stopReason as CohereResponse["finish_reason"]) ?? "COMPLETE",
      usage: {
        tokens: {
          input_tokens: this.state.usage?.inputTokens ?? 0,
          output_tokens: this.state.usage?.outputTokens ?? 0,
        },
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

/**
 * Convert tool results in messages to TOON format
 */
export async function convertToolResultsToToon(
  messages: CohereMessages,
  model: string,
): Promise<{
  messages: CohereMessages;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("cohere");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    // Only process tool messages
    if (message.role === "tool" && typeof message.content === "string") {
      toolResultCount++;
      try {
        const unwrapped = unwrapToolContent(message.content);
        const parsed = JSON.parse(unwrapped);
        const noncompressed = unwrapped;
        const compressed = toonEncode(parsed);

        const tokensBefore = tokenizer.countTokens([
          { role: "user", content: noncompressed },
        ]);
        const tokensAfter = tokenizer.countTokens([
          { role: "user", content: compressed },
        ]);
        totalTokensBefore += tokensBefore;
        totalTokensAfter += tokensAfter;

        logger.info(
          {
            toolCallId: message.tool_call_id,
            beforeLength: noncompressed.length,
            afterLength: compressed.length,
            tokensBefore,
            tokensAfter,
            provider: "cohere",
          },
          "convertToolResultsToToon: compressed",
        );

        return {
          ...message,
          content: compressed,
        };
      } catch {
        logger.info(
          {
            toolCallId: message.tool_call_id,
          },
          "convertToolResultsToToon: skipping - content is not JSON",
        );
        return message;
      }
    }
    return message;
  });

  logger.info(
    { messageCount: messages.length, toolResultCount },
    "convertToolResultsToToon completed",
  );

  // Calculate cost savings
  let toonCostSavings: number | null = null;
  if (toolResultCount > 0) {
    const tokensSaved = totalTokensBefore - totalTokensAfter;
    if (tokensSaved > 0) {
      const tokenPrice = await TokenPriceModel.findByModel(model);
      if (tokenPrice) {
        const inputPricePerToken =
          Number(tokenPrice.pricePerMillionInput) / 1000000;
        toonCostSavings = tokensSaved * inputPricePerToken;
      }
    }
  }

  return {
    messages: result,
    stats: {
      toonTokensBefore: toolResultCount > 0 ? totalTokensBefore : null,
      toonTokensAfter: toolResultCount > 0 ? totalTokensAfter : null,
      toonCostSavings,
    },
  };
}

// =============================================================================
// COHERE CLIENT
// =============================================================================

/**
 * Simple Cohere client for making API requests
 */
class CohereClient {
  private apiKey: string | undefined;
  private baseUrl: string;
  private customFetch: typeof fetch | undefined;

  constructor(
    apiKey: string | undefined,
    baseUrl?: string,
    customFetch?: typeof fetch,
  ) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl ?? "https://api.cohere.ai";
    this.customFetch = customFetch;
  }

  async chat(request: CohereRequest): Promise<CohereResponse> {
    const fetchFn = this.customFetch ?? fetch;
    const response = await fetchFn(`${this.baseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ ...request, stream: false }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cohere API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<CohereResponse>;
  }

  async *chatStream(
    request: CohereRequest,
  ): AsyncGenerator<CohereStreamChunk, void, unknown> {
    const fetchFn = this.customFetch ?? fetch;
    const response = await fetchFn(`${this.baseUrl}/v2/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ ...request, stream: true }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cohere API error: ${response.status} ${errorText}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (trimmedLine.startsWith("data: ")) {
            const data = trimmedLine.slice(6);
            if (data && data !== "[DONE]") {
              try {
                const chunk = JSON.parse(data) as CohereStreamChunk;
                yield chunk;
              } catch {
                // Skip invalid JSON
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const cohereAdapterFactory: LLMProvider<
  CohereRequest,
  CohereResponse,
  CohereMessages,
  CohereStreamChunk,
  CohereHeaders
> = {
  provider: "cohere",
  interactionType: "cohere:chat",

  createRequestAdapter(
    request: CohereRequest,
  ): LLMRequestAdapter<CohereRequest, CohereMessages> {
    return new CohereRequestAdapter(request);
  },

  createResponseAdapter(
    response: CohereResponse,
  ): LLMResponseAdapter<CohereResponse> {
    return new CohereResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<CohereStreamChunk, CohereResponse> {
    return new CohereStreamAdapter();
  },

  extractApiKey(headers: CohereHeaders): string | undefined {
    const auth = headers.authorization;
    if (auth?.startsWith("Bearer ")) {
      return auth.slice(7);
    }
    return auth;
  },

  getBaseUrl(): string | undefined {
    return config.llm.cohere?.baseUrl;
  },

  getSpanName(): string {
    return "cohere.chat";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): CohereClient {
    // Use observable fetch for request duration metrics if agent is provided
    const customFetch = options?.agent
      ? getObservableFetch("cohere", options.agent, options.externalAgentId)
      : undefined;

    return new CohereClient(apiKey, options?.baseUrl, customFetch);
  },

  async execute(
    client: unknown,
    request: CohereRequest,
  ): Promise<CohereResponse> {
    const cohereClient = client as CohereClient;
    return cohereClient.chat(request);
  },

  async executeStream(
    client: unknown,
    request: CohereRequest,
  ): Promise<AsyncIterable<CohereStreamChunk>> {
    const cohereClient = client as CohereClient;
    return {
      [Symbol.asyncIterator]: () => cohereClient.chatStream(request),
    };
  },

  extractErrorMessage(error: unknown): string {
    const cohereMessage = get(error, "message");
    if (typeof cohereMessage === "string") {
      return cohereMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
