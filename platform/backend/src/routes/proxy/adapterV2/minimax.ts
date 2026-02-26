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
  StreamAccumulatorState,
  UsageView,
} from "@/types";
import type { Minimax } from "@/types/llm-providers";
import type { ToolCompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type MinimaxRequest = Minimax.Types.ChatCompletionsRequest;
type MinimaxResponse = Minimax.Types.ChatCompletionsResponse;
type MinimaxMessages = Minimax.Types.ChatCompletionsRequest["messages"];
type MinimaxHeaders = Minimax.Types.ChatCompletionsHeaders;
type MinimaxStreamChunk = Minimax.Types.ChatCompletionChunk;

// =============================================================================
// MINIMAX SDK CLIENT
// =============================================================================

/**
 * Custom MiniMax client implementing OpenAI-compatible API
 * MiniMax uses Bearer token authentication at https://api.minimax.io/v1
 */
class MinimaxClient {
  private apiKey: string | undefined;
  private baseURL: string;
  private customFetch?: typeof fetch;

  constructor(
    apiKey: string | undefined,
    baseURL?: string,
    customFetch?: typeof fetch,
  ) {
    this.apiKey = apiKey;
    // Default to international endpoint
    this.baseURL = baseURL || "https://api.minimax.io/v1";
    this.customFetch = customFetch;
  }

  async chatCompletions(request: MinimaxRequest): Promise<MinimaxResponse> {
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
      let errorMessage = `MiniMax API error: ${response.status} ${response.statusText}`;

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

    return response.json() as Promise<MinimaxResponse>;
  }

  async chatCompletionsStream(
    request: MinimaxRequest,
  ): Promise<AsyncIterable<MinimaxStreamChunk>> {
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
      throw new Error(
        `MiniMax streaming error: ${response.status} - ${errorText}`,
      );
    }

    if (!response.body) {
      throw new Error("MiniMax streaming error: No response body");
    }

    return this.parseSSEStream(response.body);
  }

  /**
   * Parse Server-Sent Events (SSE) stream from MiniMax
   * Similar to Zhipuai's SSE parsing but handles MiniMax's reasoning_details format
   */
  private async *parseSSEStream(
    body: ReadableStream<Uint8Array>,
  ): AsyncIterable<MinimaxStreamChunk> {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        // Decode incoming bytes immediately (stream: true keeps incomplete UTF-8 sequences)
        buffer += decoder.decode(value, { stream: true });

        // Process line by line, yielding chunks as soon as we have complete lines
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in buffer
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === "data: [DONE]") continue;

          if (trimmed.startsWith("data: ")) {
            const data = trimmed.slice(6); // Remove "data: " prefix
            try {
              const chunk = JSON.parse(data) as MinimaxStreamChunk;
              yield chunk;
            } catch (error) {
              logger.warn(
                { data, error },
                "[MinimaxAdapter] Failed to parse SSE chunk",
              );
            }
          }
        }
      }

      // Process any remaining data in buffer after stream ends
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ") && trimmed !== "data: [DONE]") {
          const data = trimmed.slice(6);
          try {
            const chunk = JSON.parse(data) as MinimaxStreamChunk;
            yield chunk;
          } catch (error) {
            logger.warn(
              { data: trimmed, error },
              "[MinimaxAdapter] Failed to parse final SSE chunk",
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

/**
 * MiniMax Request Adapter
 * Handles conversion between common format and MiniMax-specific format
 *
 * Key Differences from OpenAI:
 * - MiniMax doesn't support image/audio in user messages
 * - Uses extra_body.reasoning_split to enable thinking content separation
 * - Temperature must be in range (0.0, 1.0] (excludes 0)
 * - n parameter only supports 1
 */
class MinimaxRequestAdapter
  implements LLMRequestAdapter<MinimaxRequest, MinimaxMessages>
{
  readonly provider = "minimax" as const;
  private request: MinimaxRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: MinimaxRequest) {
    this.request = request;
    // Enable reasoning_split by default for interleaved thinking support
    if (!this.request.extra_body) {
      this.request.extra_body = { reasoning_split: true };
    } else if (this.request.extra_body.reasoning_split === undefined) {
      this.request.extra_body.reasoning_split = true;
    }
  }

  /**
   * Get the provider-specific request (required by interface)
   */
  toProviderRequest(): MinimaxRequest {
    return this.buildRequest();
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

  getProviderMessages(): MinimaxMessages {
    return this.request.messages;
  }

  getOriginalRequest(): MinimaxRequest {
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

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return stats;
  }

  /**
   * Convert tool result content to MiniMax format
   * MiniMax doesn't support images in OpenAI API mode, so strip them
   */
  convertToolResultContent(messages: MinimaxMessages): MinimaxMessages {
    // Apply any pending tool result updates
    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = messages.map((msg) => {
        if (msg.role === "tool" && this.toolResultUpdates[msg.tool_call_id]) {
          return {
            ...msg,
            content: this.toolResultUpdates[msg.tool_call_id],
          };
        }
        return msg;
      });
    }

    return messages;
  }

  buildRequest(): MinimaxRequest {
    const processedMessages = this.convertToolResultContent(
      this.request.messages,
    );

    return {
      ...this.request,
      model: this.getModel(),
      messages: processedMessages,
    };
  }

  estimateRequestCost(model: string): Promise<number> {
    return estimateRequestCost(model, this.request.messages);
  }

  // ---------------------------------------------------------------------------
  // Helper Methods
  // ---------------------------------------------------------------------------

  /**
   * Convert MiniMax messages to common format
   * CommonMessage is a minimal representation - only stores role and tool calls
   */
  private toCommonFormat(messages: MinimaxMessages): CommonMessage[] {
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

    return commonMessages;
  }

  /**
   * Find tool name from tool_call_id by looking at previous assistant messages
   */
  private findToolNameInMessages(
    messages: MinimaxMessages,
    toolCallId: string,
  ): string | null {
    // Search backwards through messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && msg.tool_calls) {
        const toolCall = msg.tool_calls.find(
          (tc) => "id" in tc && tc.id === toolCallId,
        );
        if (toolCall && toolCall.type === "function") {
          return toolCall.function.name;
        }
      }
    }
    return null;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

/**
 * MiniMax Response Adapter
 * Handles non-streaming responses
 *
 * Key Differences from OpenAI:
 * - reasoning_details is an array of {text: string} objects
 * - No refusal field in responses
 */
class MinimaxResponseAdapter implements LLMResponseAdapter<MinimaxResponse> {
  readonly provider = "minimax" as const;
  private response: MinimaxResponse;

  constructor(response: MinimaxResponse) {
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
      if (toolCall.type !== "function") {
        return {
          id: toolCall.id,
          name: "unknown",
          arguments: {},
        };
      }

      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
        // Keep empty object if parsing fails
      }

      return {
        id: toolCall.id,
        name: toolCall.function.name,
        arguments: args,
      };
    });
  }

  hasToolCalls(): boolean {
    const choice = this.response.choices[0];
    return (choice?.message.tool_calls?.length ?? 0) > 0;
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.usage?.prompt_tokens ?? 0,
      outputTokens: this.response.usage?.completion_tokens ?? 0,
    };
  }

  getOriginalResponse(): MinimaxResponse {
    return this.response;
  }

  getFinishReasons(): string[] {
    const reason = this.response.choices[0]?.finish_reason;
    return reason ? [reason] : [];
  }

  /**
   * Convert response to refusal format for blocked tool calls
   * MiniMax doesn't have a refusal field, so we use content only
   */
  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): MinimaxResponse {
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
 * MiniMax Stream Adapter
 * Handles streaming responses with SSE format
 *
 * Key Differences from OpenAI:
 * - reasoning_details is streamed as array of {text: string} deltas
 * - Text in reasoning_details accumulates (includes full text so far)
 * - Need to track last reasoning text to extract deltas
 * - MiniMax streaming does NOT provide usage - we estimate it
 */
class MinimaxStreamAdapter
  implements LLMStreamAdapter<MinimaxStreamChunk, MinimaxResponse>
{
  readonly provider = "minimax" as const;
  readonly state: StreamAccumulatorState;
  private currentToolCallIndices = new Map<number, number>();
  private lastReasoningText = ""; // Track full reasoning text seen so far
  private request: MinimaxRequest | undefined; // Store request for token estimation (optional)

  constructor(request?: MinimaxRequest) {
    this.request = request;
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

  processChunk(chunk: MinimaxStreamChunk): ChunkProcessingResult {
    const delta = chunk.choices[0]?.delta;
    if (!delta) {
      return { sseData: null, isToolCallChunk: false, isFinal: false };
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Update state
    if (chunk.id) this.state.responseId = chunk.id;
    if (chunk.model) this.state.model = chunk.model;

    // Handle content delta
    if (delta.content) {
      this.state.text += delta.content;
      sseData = `data: ${JSON.stringify(chunk)}\n\n`;
    }

    // Handle reasoning_details delta (thinking content)
    // MiniMax sends full accumulated text in each chunk, so we need to extract the delta
    if (delta.reasoning_details && delta.reasoning_details.length > 0) {
      // Get the full reasoning text from the first detail
      const fullReasoningText = delta.reasoning_details[0]?.text || "";

      // Extract only the new text (delta)
      if (fullReasoningText.length > this.lastReasoningText.length) {
        // Note: reasoning is stored but not in StreamAccumulatorState - tracked separately
        this.lastReasoningText = fullReasoningText;
      }

      sseData = `data: ${JSON.stringify(chunk)}\n\n`;
    }

    // Handle tool_calls delta
    if (delta.tool_calls) {
      for (const toolCallDelta of delta.tool_calls) {
        const index = toolCallDelta.index;

        // Initialize tool call at this index if needed
        if (!this.currentToolCallIndices.has(index)) {
          this.currentToolCallIndices.set(index, this.state.toolCalls.length);
          this.state.toolCalls.push({
            id: toolCallDelta.id || "",
            name: "",
            arguments: "",
          });
        }

        const toolCallIndex = this.currentToolCallIndices.get(index);
        if (toolCallIndex === undefined) continue;
        const toolCall = this.state.toolCalls[toolCallIndex];

        // Update tool call fields
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

    // Handle usage (typically in final chunk)
    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    // Check if stream is complete
    const finishReason = chunk.choices[0]?.finish_reason;
    if (finishReason) {
      this.state.stopReason = finishReason;
      isFinal = true;
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  // ---------------------------------------------------------------------------
  // SSE Formatting
  // ---------------------------------------------------------------------------

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    const chunk: MinimaxStreamChunk = {
      id: this.state.responseId || `chatcmpl-${Date.now()}`,
      model: this.state.model || "minimax",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map((chunk) => {
      return `data: ${JSON.stringify(chunk)}\n\n`;
    });
  }

  formatCompleteTextSSE(text: string): string[] {
    const events: string[] = [];

    // Initial chunk with role
    events.push(this.formatTextDeltaSSE(""));

    // Content chunk
    events.push(this.formatTextDeltaSSE(text));

    // Final chunk with finish_reason
    const finalChunk: MinimaxStreamChunk = {
      id: this.state.responseId || `chatcmpl-${Date.now()}`,
      model: this.state.model || "minimax",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };
    events.push(`data: ${JSON.stringify(finalChunk)}\n\n`);

    return events;
  }

  formatEndSSE(): string {
    if (!this.state.usage) {
      this.estimateUsage();
    }
    return "data: [DONE]\n\n";
  }

  // ---------------------------------------------------------------------------
  // Build Response
  // ---------------------------------------------------------------------------

  toProviderResponse(): MinimaxResponse {
    // Parse tool call arguments
    const toolCalls = this.state.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));

    // Ensure stopReason is a valid finish_reason
    const validFinishReason:
      | "stop"
      | "length"
      | "tool_calls"
      | "content_filter" =
      this.state.stopReason === "tool_calls" ||
      this.state.stopReason === "length" ||
      this.state.stopReason === "content_filter"
        ? this.state.stopReason
        : "stop";

    return {
      id: this.state.responseId,
      model: this.state.model,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.state.text || null,
            // Convert accumulated reasoning back to reasoning_details format if present
            ...(this.lastReasoningText
              ? { reasoning_details: [{ text: this.lastReasoningText }] }
              : {}),
            ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
          },
          finish_reason: validFinishReason,
        },
      ],
      usage: this.state.usage
        ? {
            prompt_tokens: this.state.usage.inputTokens,
            completion_tokens: this.state.usage.outputTokens,
            total_tokens:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          }
        : this.estimateUsage(),
    };
  }

  /**
   * Estimate token usage since MiniMax streaming doesn't provide it
   * Uses tokenizer to count tokens in request messages and response text
   */
  private estimateUsage(): {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  } {
    const tokenizer = getTokenizer("minimax");

    // Estimate input tokens from messages (only if request is available)
    let inputTokens = 0;
    if (this.request?.messages) {
      // Use countTokens with proper message format
      inputTokens = tokenizer.countTokens(
        this.request.messages.map((m) => {
          if (m.role === "system") {
            return { role: "system" as const, content: m.content || "" };
          }
          if (m.role === "user") {
            return { role: "user" as const, content: m.content || "" };
          }
          if (m.role === "tool") {
            const content =
              typeof m.content === "string"
                ? m.content
                : JSON.stringify(m.content);
            return { role: "user" as const, content };
          }
          // assistant
          return { role: "assistant" as const, content: m.content || "" };
        }),
      );
    }

    // Estimate output tokens from accumulated text and reasoning
    let outputTokens = 0;
    if (this.state.text) {
      outputTokens += tokenizer.countTokens([
        { role: "assistant" as const, content: this.state.text },
      ]);
    }
    if (this.lastReasoningText) {
      outputTokens += tokenizer.countTokens([
        { role: "assistant" as const, content: this.lastReasoningText },
      ]);
    }

    // Add tokens for tool calls if present
    for (const toolCall of this.state.toolCalls) {
      outputTokens += tokenizer.countTokens([
        {
          role: "assistant" as const,
          content: `${toolCall.name}${JSON.stringify(toolCall.arguments)}`,
        },
      ]);
    }

    // Update state.usage with estimated values so it's available for metrics
    this.state.usage = {
      inputTokens,
      outputTokens,
    };

    return {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
    };
  }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Convert tool results to TOON format for compression
 * Same logic as OpenAI/Zhipuai
 */
async function convertToolResultsToToon(
  messages: MinimaxMessages,
  model: string,
): Promise<{ messages: MinimaxMessages; stats: ToolCompressionStats }> {
  const tokenizer = getTokenizer("minimax");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
      logger.info(
        {
          toolCallId: message.tool_call_id,
          contentType: typeof message.content,
          provider: "minimax",
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

          totalTokensBefore += tokensBefore;
          totalTokensAfter += tokensAfter;
          toolResultCount++;

          logger.info(
            {
              toolCallId: message.tool_call_id,
              tokensBefore,
              tokensAfter,
              tokensSaved: tokensBefore - tokensAfter,
              provider: "minimax",
            },
            "convertToolResultsToToon: tool result compressed",
          );

          return {
            ...message,
            content: compressed,
          };
        } catch (err) {
          logger.warn(
            { err, toolCallId: message.tool_call_id },
            "Failed to compress tool result",
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
  if (toolResultCount > 0) {
    const tokensSaved = totalTokensBefore - totalTokensAfter;
    if (tokensSaved > 0) {
      toonCostSavings = await ModelModel.calculateCostSavings(
        model,
        tokensSaved,
        "minimax",
      );
    }
  }

  return {
    messages: result,
    stats: {
      tokensBefore: toolResultCount > 0 ? totalTokensBefore : 0,
      tokensAfter: toolResultCount > 0 ? totalTokensAfter : 0,
      costSavings: toonCostSavings,
      wasEffective: totalTokensAfter < totalTokensBefore,
      hadToolResults: toolResultCount > 0,
    },
  };
}

/**
 * Estimate the cost of a request based on message token counts
 */
async function estimateRequestCost(
  model: string,
  messages: MinimaxMessages,
): Promise<number> {
  const tokenizer = getTokenizer("minimax");

  // Convert messages to proper format for tokenizer
  const tokenizableMessages = messages.map((m) => {
    if (m.role === "system") {
      return { role: "system" as const, content: m.content || "" };
    }
    if (m.role === "user") {
      return { role: "user" as const, content: m.content || "" };
    }
    if (m.role === "tool") {
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return { role: "user" as const, content };
    }
    // assistant
    return { role: "assistant" as const, content: m.content || "" };
  });

  const totalTokens = tokenizer.countTokens(tokenizableMessages);

  return ModelModel.calculateCostSavings(model, totalTokens, "minimax");
}

// =============================================================================
// PROVIDER FACTORY
// =============================================================================

/**
 * MiniMax Adapter Factory
 * Creates adapters and client for MiniMax provider
 */
export const minimaxAdapterFactory: LLMProvider<
  MinimaxRequest,
  MinimaxResponse,
  MinimaxMessages,
  MinimaxStreamChunk,
  MinimaxHeaders
> = {
  provider: "minimax",
  interactionType: "minimax:chatCompletions",

  createRequestAdapter(
    request: MinimaxRequest,
  ): LLMRequestAdapter<MinimaxRequest, MinimaxMessages> {
    return new MinimaxRequestAdapter(request);
  },

  createResponseAdapter(
    response: MinimaxResponse,
  ): LLMResponseAdapter<MinimaxResponse> {
    return new MinimaxResponseAdapter(response);
  },

  createStreamAdapter(
    request?: MinimaxRequest,
  ): LLMStreamAdapter<MinimaxStreamChunk, MinimaxResponse> {
    return new MinimaxStreamAdapter(request);
  },

  extractApiKey(headers: MinimaxHeaders): string | undefined {
    const auth = headers.authorization;
    if (!auth) return undefined;
    // Extract Bearer token
    const match = auth.match(/^Bearer\s+(.+)$/i);
    return match?.[1];
  },

  getBaseUrl(): string | undefined {
    return config.llm.minimax.baseUrl;
  },

  spanName: "chat",

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): MinimaxClient {
    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "minimax",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    const baseUrl = options?.baseUrl || config.llm.minimax.baseUrl;
    return new MinimaxClient(apiKey, baseUrl, customFetch);
  },

  async execute(
    client: unknown,
    request: MinimaxRequest,
  ): Promise<MinimaxResponse> {
    const minimaxClient = client as MinimaxClient;
    return minimaxClient.chatCompletions({
      ...request,
      stream: false,
    });
  },

  async executeStream(
    client: unknown,
    request: MinimaxRequest,
  ): Promise<AsyncIterable<MinimaxStreamChunk>> {
    const minimaxClient = client as MinimaxClient;
    return minimaxClient.chatCompletionsStream({
      ...request,
      stream: true,
    });
  },

  extractErrorMessage(error: unknown): string {
    // MiniMax error structure
    const minimaxMessage = get(error, "error.message");
    if (typeof minimaxMessage === "string") {
      return minimaxMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};

export function getUsageTokens(usage: Minimax.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}
