import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
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
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
  Deepseek,
} from "@/types";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type DeepSeekRequest = Deepseek.Types.ChatCompletionsRequest;
type DeepSeekResponse = Deepseek.Types.ChatCompletionsResponse;
type DeepSeekMessages = DeepSeekRequest["messages"];
type DeepSeekHeaders = Deepseek.Types.ChatCompletionsHeaders;
type DeepSeekStreamChunk = Deepseek.Types.ChatCompletionChunk;

// =============================================================================
// DEEPSEEK SDK CLIENT
// =============================================================================

class DeepSeekClient {
  private apiKey: string | undefined;
  private baseURL: string;
  private customFetch?: typeof fetch;

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    customFetch?: typeof fetch,
  ) {
    this.apiKey = apiKey;
    this.baseURL = baseURL || "https://api.deepseek.com/v1";
    this.customFetch = customFetch;
  }

  async chatCompletions(request: DeepSeekRequest): Promise<DeepSeekResponse> {
    const fetchFn = this.customFetch || fetch;
    const response = await fetchFn(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        ...request,
        stream: false,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DeepSeek API error: ${response.status} ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMessage += ` - ${errorJson.error.message}`;
        } else {
          errorMessage += ` - ${errorText}`;
        }
      } catch {
        errorMessage += ` - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    return response.json() as Promise<DeepSeekResponse>;
  }

  async chatCompletionsStream(
    request: DeepSeekRequest,
  ): Promise<AsyncIterable<DeepSeekStreamChunk>> {
    const fetchFn = this.customFetch || fetch;
    const response = await fetchFn(`${this.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey && { Authorization: `Bearer ${this.apiKey}` }),
      },
      body: JSON.stringify({
        ...request,
        stream: true,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      let errorMessage = `DeepSeek API error: ${response.status} ${response.statusText}`;

      try {
        const errorJson = JSON.parse(errorText);
        if (errorJson.error?.message) {
          errorMessage += ` - ${errorJson.error.message}`;
        } else {
          errorMessage += ` - ${errorText}`;
        }
      } catch {
        errorMessage += ` - ${errorText}`;
      }

      throw new Error(errorMessage);
    }

    return this.parseSSEStream(response);
  }

  private async *parseSSEStream(
    response: Response,
  ): AsyncIterable<DeepSeekStreamChunk> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("Response body is not readable");
    }

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Decode incoming bytes immediately (stream: true keeps incomplete UTF-8 sequences)
        buffer += decoder.decode(value, { stream: true });

        // Process line by line, yielding chunks as soon as we have complete lines
        const lines = buffer.split("\n");
        // Keep the last incomplete line in the buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            try {
              const jsonStr = trimmed.substring(6);
              const chunk = JSON.parse(jsonStr) as DeepSeekStreamChunk;
              // Yield immediately - don't accumulate
              yield chunk;
            } catch (error) {
              logger.warn(
                { error, line: trimmed },
                "Failed to parse SSE chunk from DeepSeek",
              );
            }
          }
        }
      }

      // Process any remaining data in buffer after stream ends
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          try {
            const jsonStr = trimmed.substring(6);
            const chunk = JSON.parse(jsonStr) as DeepSeekStreamChunk;
            yield chunk;
          } catch (error) {
            logger.warn(
              { error, line: trimmed },
              "Failed to parse final SSE chunk from DeepSeek",
            );
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class DeepSeekRequestAdapter
  implements LLMRequestAdapter<DeepSeekRequest, DeepSeekMessages>
{
  readonly provider = "deepseek" as const;
  private request: DeepSeekRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: DeepSeekRequest) {
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
        const toolName = this.findToolNameInMessages(
          this.request.messages,
          message.tool_call_id,
        );

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
      if (tool.type === "function") {
        result.push({
          name: tool.function.name,
          description: tool.function.description,
          inputSchema: tool.function.parameters as Record<string, unknown>,
        });
      }
    }
    return result;
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): DeepSeekMessages {
    return this.request.messages;
  }

  getOriginalRequest(): DeepSeekRequest {
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

  convertToolResultContent(messages: DeepSeekMessages): DeepSeekMessages {
    // DeepSeek uses OpenAI-compatible format, so no conversion needed
    // Future: implement MCP image block conversion if needed
    return messages;
  }

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): DeepSeekRequest {
    let messages = this.request.messages;

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

  private findToolNameInMessages(
    messages: DeepSeekMessages,
    toolCallId: string,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.id === toolCallId) {
            if (toolCall.type === "function") {
              return toolCall.function.name;
            }
          }
        }
      }
    }

    return null;
  }

  private toCommonFormat(messages: DeepSeekMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[DeepSeekAdapter] toCommonFormat: starting conversion",
    );
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role as CommonMessage["role"],
      };

      if (message.role === "tool") {
        const toolName = this.findToolNameInMessages(
          messages,
          message.tool_call_id,
        );

        if (toolName) {
          logger.debug(
            { toolCallId: message.tool_call_id, toolName },
            "[DeepSeekAdapter] toCommonFormat: found tool message",
          );
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
      "[DeepSeekAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  private applyUpdates(
    messages: DeepSeekMessages,
    updates: Record<string, string>,
  ): DeepSeekMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[DeepSeekAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[DeepSeekAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      if (message.role === "tool" && updates[message.tool_call_id]) {
        appliedCount++;
        logger.debug(
          { toolCallId: message.tool_call_id },
          "[DeepSeekAdapter] applyUpdates: applying update to tool message",
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
      "[DeepSeekAdapter] applyUpdates: complete",
    );
    return result;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class DeepSeekResponseAdapter implements LLMResponseAdapter<DeepSeekResponse> {
  readonly provider = "deepseek" as const;
  private response: DeepSeekResponse;

  constructor(response: DeepSeekResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    return this.response.model;
  }

  getText(): string {
    const choice = this.response.choices[0];
    if (!choice) return "";
    return choice.message.content ?? "";
  }

  getToolCalls(): CommonToolCall[] {
    const choice = this.response.choices[0];
    if (!choice?.message.tool_calls) return [];

    return choice.message.tool_calls.map((toolCall) => {
      let name: string;
      let args: Record<string, unknown>;

      if (toolCall.type === "function" && toolCall.function) {
        name = toolCall.function.name;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch {
          args = {};
        }
      } else {
        name = "unknown";
        args = {};
      }

      return {
        id: toolCall.id,
        name,
        arguments: args,
      };
    });
  }

  hasToolCalls(): boolean {
    const choice = this.response.choices[0];
    return (choice?.message.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    if (!this.response.usage) {
      return { inputTokens: 0, outputTokens: 0 };
    }
    const { input, output } = getUsageTokens(this.response.usage);
    return { inputTokens: input, outputTokens: output };
  }

  getOriginalResponse(): DeepSeekResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): DeepSeekResponse {
    return {
      ...this.response,
      choices: [
        {
          ...this.response.choices[0],
          message: {
            role: "assistant",
            content: contentMessage,
          },
          finish_reason: "stop",
        },
      ],
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

/**
 * DeepSeekStreamAdapter processes streaming chunks and accumulates state.
 * DeepSeek uses OpenAI-compatible streaming format with SSE.
 */
class DeepSeekStreamAdapter
  implements LLMStreamAdapter<DeepSeekStreamChunk, DeepSeekResponse>
{
  readonly provider = "deepseek" as const;
  readonly state: StreamAccumulatorState;
  private currentToolCallIndices = new Map<number, number>();

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

  processChunk(chunk: DeepSeekStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    this.state.responseId = chunk.id;
    this.state.model = chunk.model;

    const choice = chunk.choices[0];
    if (!choice) {
      // Empty chunk (shouldn't happen with DeepSeek, but handle it)
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    const delta = choice.delta;

    // Handle text content accumulation
    if (delta.content) {
      this.state.text += delta.content;
    }

    // Only forward chunks with meaningful content updates to prevent empty deltas
    const hasContent =
      delta.content ||
      delta.tool_calls ||
      delta.role;

    if (hasContent) {
      sseData = `data: ${JSON.stringify(chunk)}\n\n`;
    }

    if (delta.tool_calls) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index;

        if (!this.currentToolCallIndices.has(index)) {
          this.currentToolCallIndices.set(index, this.state.toolCalls.length);
          this.state.toolCalls.push({
            id: toolCallDelta.id ?? "",
            name: toolCallDelta.function?.name ?? "",
            arguments: "",
          });
        }

        const toolCallIndex = this.currentToolCallIndices.get(index);
        if (toolCallIndex === undefined) continue;
        const toolCall = this.state.toolCalls[toolCallIndex];

        if (toolCallDelta.id) {
          toolCall.id = toolCallDelta.id;
        }
        if (toolCallDelta.function?.name) {
          toolCall.name = toolCallDelta.function.name;
        }
        if (toolCallDelta.function?.arguments) {
          toolCall.arguments += toolCallDelta.function.arguments;
        }
      }

      this.state.rawToolCallEvents.push(chunk);
      isToolCallChunk = true;
    }

    if (choice.finish_reason) {
      this.state.stopReason = choice.finish_reason;
      isFinal = true;
    }

    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // Disable nginx buffering
    };
  }

  formatTextDeltaSSE(text: string): string {
    const chunk: DeepSeekStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: {
            content: text,
          },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map(
      (event) => `data: ${JSON.stringify(event)}\n\n`,
    );
  }

  formatCompleteTextSSE(text: string): string[] {
    const chunk: DeepSeekStreamChunk = {
      id: this.state.responseId || `chatcmpl-${Date.now()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            content: text,
          },
          finish_reason: null,
        },
      ],
    };
    return [`data: ${JSON.stringify(chunk)}\n\n`];
  }

  formatEndSSE(): string {
    const finalChunk: DeepSeekStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: this.state.stopReason ?? "stop",
        },
      ],
    };
    return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
  }

  toProviderResponse(): DeepSeekResponse {
    const toolCalls =
      this.state.toolCalls.length > 0
        ? this.state.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          }))
        : undefined;

    return {
      id: this.state.responseId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.state.text || null,
            tool_calls: toolCalls,
          },
          logprobs: null,
          finish_reason:
            (this.state.stopReason as Deepseek.Types.FinishReason) ?? "stop",
        },
      ],
      usage: {
        prompt_tokens: this.state.usage?.inputTokens ?? 0,
        completion_tokens: this.state.usage?.outputTokens ?? 0,
        total_tokens:
          (this.state.usage?.inputTokens ?? 0) +
          (this.state.usage?.outputTokens ?? 0),
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

async function convertToolResultsToToon(
  messages: DeepSeekMessages,
  model: string,
): Promise<{
  messages: DeepSeekMessages;
  stats: ToolCompressionStats;
}> {
  const tokenizer = getTokenizer("deepseek");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
      logger.info(
        {
          toolCallId: message.tool_call_id,
          contentType: typeof message.content,
          provider: "deepseek",
        },
        "convertToolResultsToToon: tool message found",
      );

      if (typeof message.content === "string") {
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

          toolResultCount++;

          // Always count tokens before
          totalTokensBefore += tokensBefore;

          // Only apply compression if it actually saves tokens
          if (tokensAfter < tokensBefore) {
            totalTokensAfter += tokensAfter;

            logger.info(
              {
                toolCallId: message.tool_call_id,
                beforeLength: noncompressed.length,
                afterLength: compressed.length,
                tokensBefore,
                tokensAfter,
                toonPreview: compressed.substring(0, 150),
                provider: "deepseek",
              },
              "convertToolResultsToToon: compressed",
            );

            return {
              ...message,
              content: compressed,
            };
          }

          // Compression not applied - count non-compressed tokens to track total tokens anyway
          totalTokensAfter += tokensBefore;
          logger.info(
            {
              toolCallId: message.tool_call_id,
              tokensBefore,
              tokensAfter,
              provider: "deepseek",
            },
            "Skipping TOON compression - compressed output has more tokens",
          );
        } catch {
          logger.info(
            {
              toolCallId: message.tool_call_id,
              contentPreview:
                typeof message.content === "string"
                  ? message.content.substring(0, 100)
                  : "non-string",
            },
            "Skipping TOON conversion - content is not JSON",
          );
          return message;
        }
      }
    }

    return message;
  });

  logger.info(
    { messageCount: messages.length, toolResultCount },
    "convertToolResultsToToon completed",
  );

  let toonCostSavings = 0;
  const tokensSaved = totalTokensBefore - totalTokensAfter;
  if (tokensSaved > 0) {
    const tokenPrice = await TokenPriceModel.findByModel(model);
    if (tokenPrice) {
      const inputPricePerToken =
        Number(tokenPrice.pricePerMillionInput) / 1000000;
      toonCostSavings = tokensSaved * inputPricePerToken;
    }
  }

  return {
    messages: result,
    stats: {
      tokensBefore: totalTokensBefore,
      tokensAfter: totalTokensAfter,
      costSavings: toonCostSavings,
      wasEffective: totalTokensAfter < totalTokensBefore,
      hadToolResults: toolResultCount > 0,
    },
  };
}

// =============================================================================
// USAGE TOKEN HELPERS
// =============================================================================

export function getUsageTokens(usage: Deepseek.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const deepseekAdapterFactory: LLMProvider<
  DeepSeekRequest,
  DeepSeekResponse,
  DeepSeekMessages,
  DeepSeekStreamChunk,
  DeepSeekHeaders
> = {
  provider: "deepseek",
  interactionType: "deepseek:chatCompletions",

  createRequestAdapter(
    request: DeepSeekRequest,
  ): LLMRequestAdapter<DeepSeekRequest, DeepSeekMessages> {
    return new DeepSeekRequestAdapter(request);
  },

  createResponseAdapter(
    response: DeepSeekResponse,
  ): LLMResponseAdapter<DeepSeekResponse> {
    return new DeepSeekResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<DeepSeekStreamChunk, DeepSeekResponse> {
    return new DeepSeekStreamAdapter();
  },

  extractApiKey(headers: DeepSeekHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.deepseek.baseUrl;
  },

  getSpanName(): string {
    return "deepseek.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): DeepSeekClient {
    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "deepseek",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new DeepSeekClient(apiKey, options?.baseUrl, customFetch);
  },

  async execute(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<DeepSeekResponse> {
    const deepseekClient = client as DeepSeekClient;
    return deepseekClient.chatCompletions(request);
  },

  async executeStream(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<AsyncIterable<DeepSeekStreamChunk>> {
    const deepseekClient = client as DeepSeekClient;
    return deepseekClient.chatCompletionsStream(request);
  },

  extractErrorMessage(error: unknown): string {
    // Try to extract message from DeepSeek error structure
    const deepseekMessage = get(error, "error.message");
    if (typeof deepseekMessage === "string") {
      return deepseekMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};