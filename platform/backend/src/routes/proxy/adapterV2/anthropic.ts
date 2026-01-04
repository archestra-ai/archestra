import AnthropicProvider from "@anthropic-ai/sdk";
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import config from "@/config";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  Anthropic,
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  StreamAccumulatorState,
  ToonCompressionResult,
  UsageView,
} from "@/types";
import { MockAnthropicClient } from "../mock-anthropic-client";
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type AnthropicRequest = Anthropic.Types.MessagesRequest;
type AnthropicResponse = Anthropic.Types.MessagesResponse;
type AnthropicMessages = Anthropic.Types.MessagesRequest["messages"];
type AnthropicHeaders = Anthropic.Types.MessagesHeaders;
type AnthropicStreamChunk = AnthropicProvider.Messages.MessageStreamEvent;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class AnthropicRequestAdapter
  implements LLMRequestAdapter<AnthropicRequest, AnthropicMessages>
{
  readonly provider = "anthropic" as const;
  private request: AnthropicRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: AnthropicRequest) {
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
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const contentBlock of message.content) {
          if (contentBlock.type === "tool_result") {
            // Find tool name from previous assistant messages
            const toolName = this.findToolName(contentBlock.tool_use_id);

            let content: unknown;
            if (typeof contentBlock.content === "string") {
              try {
                content = JSON.parse(contentBlock.content);
              } catch {
                content = contentBlock.content;
              }
            } else {
              content = contentBlock.content;
            }

            results.push({
              id: contentBlock.tool_use_id,
              name: toolName ?? "unknown",
              content,
              isError: contentBlock.is_error ?? false,
            });
          }
        }
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.tools) return [];

    const result: CommonMcpToolDefinition[] = [];
    for (const tool of this.request.tools) {
      // Only process custom tools (not bash, text_editor, etc.)
      if (
        tool.type === undefined ||
        tool.type === null ||
        tool.type === "custom"
      ) {
        // Type narrowing: at this point tool has input_schema
        const customTool = tool as {
          name: string;
          input_schema: Record<string, unknown>;
          description?: string;
        };
        result.push({
          name: customTool.name,
          description: customTool.description,
          inputSchema: customTool.input_schema,
        });
      }
    }
    return result;
  }

  hasTools(): boolean {
    return (this.request.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): AnthropicMessages {
    return this.request.messages;
  }

  getOriginalRequest(): AnthropicRequest {
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

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): AnthropicRequest {
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

  private findToolName(toolUseId: string): string | null {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];
      if (
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.length > 0
      ) {
        for (const content of message.content) {
          if (content.type === "tool_use" && content.id === toolUseId) {
            return content.name;
          }
        }
      }
    }
    return null;
  }

  /**
   * Convert Anthropic messages to common format for policy evaluation
   */
  private toCommonFormat(messages: AnthropicMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[AnthropicAdapter] toCommonFormat: starting conversion",
    );
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role as CommonMessage["role"],
      };

      // Handle user messages that may contain tool results
      if (message.role === "user" && Array.isArray(message.content)) {
        const toolCalls: CommonToolResult[] = [];

        for (const contentBlock of message.content) {
          if (contentBlock.type === "tool_result") {
            // Find the tool name from previous assistant messages
            const toolName = this.findToolNameInMessages(
              messages,
              contentBlock.tool_use_id,
            );

            if (toolName) {
              logger.debug(
                { toolUseId: contentBlock.tool_use_id, toolName },
                "[AnthropicAdapter] toCommonFormat: found tool result",
              );
              // Parse the tool result
              let toolResult: unknown;
              if (typeof contentBlock.content === "string") {
                try {
                  toolResult = JSON.parse(contentBlock.content);
                } catch {
                  toolResult = contentBlock.content;
                }
              } else {
                toolResult = contentBlock.content;
              }

              toolCalls.push({
                id: contentBlock.tool_use_id,
                name: toolName,
                content: toolResult,
                isError: false,
              });
            }
          }
        }

        if (toolCalls.length > 0) {
          commonMessage.toolCalls = toolCalls;
          logger.debug(
            { toolCallCount: toolCalls.length },
            "[AnthropicAdapter] toCommonFormat: attached tool calls to message",
          );
        }
      }

      commonMessages.push(commonMessage);
    }

    logger.debug(
      { inputCount: messages.length, outputCount: commonMessages.length },
      "[AnthropicAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  /**
   * Extract tool name from messages by finding the assistant message
   * that contains the tool_use_id
   */
  private findToolNameInMessages(
    messages: AnthropicMessages,
    toolUseId: string,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.length > 0
      ) {
        for (const content of message.content) {
          if (content.type === "tool_use" && content.id === toolUseId) {
            return content.name;
          }
        }
      }
    }
    return null;
  }

  /**
   * Apply tool result updates back to Anthropic messages
   */
  private applyUpdates(
    messages: AnthropicMessages,
    updates: Record<string, string>,
  ): AnthropicMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[AnthropicAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[AnthropicAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      // Only process user messages with content arrays
      if (message.role === "user" && Array.isArray(message.content)) {
        const updatedContent = message.content.map((contentBlock) => {
          if (
            contentBlock.type === "tool_result" &&
            updates[contentBlock.tool_use_id]
          ) {
            appliedCount++;
            logger.debug(
              { toolUseId: contentBlock.tool_use_id },
              "[AnthropicAdapter] applyUpdates: applying update to tool result",
            );
            return {
              ...contentBlock,
              content: updates[contentBlock.tool_use_id],
            };
          }
          return contentBlock;
        });

        return {
          ...message,
          content: updatedContent,
        };
      }

      return message;
    });

    logger.debug(
      { updateCount, appliedCount },
      "[AnthropicAdapter] applyUpdates: complete",
    );
    return result;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class AnthropicResponseAdapter
  implements LLMResponseAdapter<AnthropicResponse>
{
  readonly provider = "anthropic" as const;
  private response: AnthropicResponse;

  constructor(response: AnthropicResponse) {
    this.response = response;
  }

  getId(): string {
    return this.response.id;
  }

  getModel(): string {
    return this.response.model;
  }

  getText(): string {
    const textBlocks = this.response.content.filter(
      (block) => block.type === "text",
    );
    return textBlocks.map((block) => block.text).join("");
  }

  getToolCalls(): CommonToolCall[] {
    return this.response.content
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input as Record<string, unknown>,
      }));
  }

  hasToolCalls(): boolean {
    return this.response.content.some((block) => block.type === "tool_use");
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.usage.input_tokens,
      outputTokens: this.response.usage.output_tokens,
    };
  }

  getOriginalResponse(): AnthropicResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): AnthropicResponse {
    return {
      ...this.response,
      content: [
        {
          type: "text",
          text: contentMessage,
          citations: null,
        },
      ],
      stop_reason: "end_turn",
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class AnthropicStreamAdapter
  implements LLMStreamAdapter<AnthropicStreamChunk, AnthropicResponse>
{
  readonly provider = "anthropic" as const;
  readonly state: StreamAccumulatorState;
  private toolUseBlockIndices = new Set<number>();
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

  processChunk(chunk: AnthropicStreamChunk): ChunkProcessingResult {
    // Track first chunk time
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    switch (chunk.type) {
      case "message_start":
        this.state.responseId = chunk.message.id;
        this.state.model = chunk.message.model;
        if (chunk.message.usage) {
          this.state.usage = {
            inputTokens: chunk.message.usage.input_tokens,
            outputTokens: chunk.message.usage.output_tokens,
          };
        }
        sseData = `event: message_start\ndata: ${JSON.stringify(chunk)}\n\n`;
        break;

      case "content_block_start":
        if (chunk.content_block.type === "text") {
          sseData = `event: content_block_start\ndata: ${JSON.stringify(chunk)}\n\n`;
        } else if (chunk.content_block.type === "tool_use") {
          this.toolUseBlockIndices.add(chunk.index);
          this.currentToolCallIndex = this.state.toolCalls.length;
          this.state.toolCalls.push({
            id: chunk.content_block.id,
            name: chunk.content_block.name,
            arguments: "",
          });
          // Store raw event for replay after policy approval
          this.state.rawToolCallEvents.push(chunk);
          isToolCallChunk = true;
        }
        break;

      case "content_block_delta":
        if (chunk.delta.type === "text_delta") {
          this.state.text += chunk.delta.text;
          sseData = `event: content_block_delta\ndata: ${JSON.stringify(chunk)}\n\n`;
        } else if (chunk.delta.type === "input_json_delta") {
          if (this.currentToolCallIndex >= 0) {
            this.state.toolCalls[this.currentToolCallIndex].arguments +=
              chunk.delta.partial_json;
          }
          // Store raw event for replay after policy approval
          this.state.rawToolCallEvents.push(chunk);
          isToolCallChunk = true;
        }
        break;

      case "content_block_stop":
        if (!this.toolUseBlockIndices.has(chunk.index)) {
          sseData = `event: content_block_stop\ndata: ${JSON.stringify(chunk)}\n\n`;
        } else {
          // Store raw event for replay after policy approval
          this.state.rawToolCallEvents.push(chunk);
          isToolCallChunk = true;
        }
        break;

      case "message_delta":
        if (chunk.delta.stop_reason) {
          this.state.stopReason = chunk.delta.stop_reason;
        }
        if (chunk.usage?.output_tokens !== undefined) {
          if (this.state.usage) {
            this.state.usage.outputTokens = chunk.usage.output_tokens;
          }
        }
        // Don't send message_delta yet - we'll send it after policy evaluation
        break;

      case "message_stop":
        isFinal = true;
        // Don't send message_stop yet - we'll send it after policy evaluation
        break;
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "anthropic-ratelimit-requests-limit": "1000",
      "anthropic-ratelimit-requests-remaining": "999",
      "anthropic-ratelimit-requests-reset": new Date(
        Date.now() + 60000,
      ).toISOString(),
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "99000",
      "anthropic-ratelimit-tokens-reset": new Date(
        Date.now() + 60000,
      ).toISOString(),
      "request-id": `req-proxy-${Date.now()}`,
    };
  }

  formatTextDeltaSSE(text: string): string {
    const event = {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text,
      },
    };
    return `event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`;
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map(
      (event) =>
        `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
    );
  }

  formatCompleteTextSSE(text: string): string[] {
    return [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: 0,
      })}\n\n`,
    ];
  }

  formatEndSSE(): string {
    const events: string[] = [];

    // message_delta with stop_reason
    events.push(
      `event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta",
        delta: {
          stop_reason: this.state.stopReason ?? "end_turn",
          stop_sequence: null,
        },
        usage: {
          output_tokens: this.state.usage?.outputTokens ?? 0,
        },
      })}\n\n`,
    );

    // message_stop
    events.push(
      `event: message_stop\ndata: ${JSON.stringify({
        type: "message_stop",
      })}\n\n`,
    );

    return events.join("");
  }

  toProviderResponse(): AnthropicResponse {
    const content: AnthropicResponse["content"] = [];

    // Add text block if we have text
    if (this.state.text) {
      content.push({
        type: "text",
        text: this.state.text,
        citations: null,
      });
    }

    // Add tool use blocks
    for (const toolCall of this.state.toolCalls) {
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(toolCall.arguments);
      } catch {
        // Keep empty object if parse fails
      }

      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: parsedInput,
      });
    }

    return {
      id: this.state.responseId,
      type: "message",
      role: "assistant",
      content,
      model: this.state.model,
      stop_reason:
        (this.state.stopReason as AnthropicResponse["stop_reason"]) ??
        "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: this.state.usage?.inputTokens ?? 0,
        output_tokens: this.state.usage?.outputTokens ?? 0,
      },
    };
  }

  toProviderRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): AnthropicResponse {
    return {
      id: this.state.responseId,
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: contentMessage,
          citations: null,
        },
      ],
      model: this.state.model,
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: this.state.usage?.inputTokens ?? 0,
        output_tokens: this.state.usage?.outputTokens ?? 0,
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

/**
 * Convert tool results in messages to TOON format
 * Returns both the converted messages and compression stats (tokens and cost savings)
 */
export async function convertToolResultsToToon(
  messages: AnthropicMessages,
  model: string,
): Promise<{
  messages: AnthropicMessages;
  stats: CompressionStats;
}> {
  const tokenizer = getTokenizer("anthropic");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    // Only process user messages with content arrays that contain tool_result blocks
    if (message.role === "user" && Array.isArray(message.content)) {
      const updatedContent = message.content.map((contentBlock) => {
        if (contentBlock.type === "tool_result" && !contentBlock.is_error) {
          toolResultCount++;
          logger.info(
            {
              toolCallId: contentBlock.tool_use_id,
              contentType: typeof contentBlock.content,
              isArray: Array.isArray(contentBlock.content),
            },
            "Processing tool_result for TOON conversion",
          );

          // Handle string content
          if (typeof contentBlock.content === "string") {
            try {
              // Unwrap any extra text block wrapping from clients
              const unwrapped = unwrapToolContent(contentBlock.content);
              const parsed = JSON.parse(unwrapped);
              const noncompressed = unwrapped;
              const compressed = toonEncode(parsed);

              // Count tokens for before and after
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
                  toolCallId: contentBlock.tool_use_id,
                  beforeLength: noncompressed.length,
                  afterLength: compressed.length,
                  tokensBefore,
                  tokensAfter,
                  toonPreview: compressed.substring(0, 150),
                  provider: "anthropic",
                },
                "convertToolResultsToToon: compressed (string content)",
              );
              logger.debug(
                {
                  toolCallId: contentBlock.tool_use_id,
                  before: noncompressed,
                  after: compressed,
                  provider: "anthropic",
                  supposedToBeJson: parsed,
                },
                "convertToolResultsToToon: before/after",
              );

              return {
                ...contentBlock,
                content: compressed,
              };
            } catch {
              logger.info(
                {
                  toolCallId: contentBlock.tool_use_id,
                  contentPreview:
                    typeof contentBlock.content === "string"
                      ? contentBlock.content.substring(0, 100)
                      : "non-string",
                },
                "convertToolResultsToToon: skipping - string content is not JSON",
              );
              return contentBlock;
            }
          }

          // Handle array content (content blocks format)
          if (Array.isArray(contentBlock.content)) {
            const updatedBlocks = contentBlock.content.map((block) => {
              if (block.type === "text" && typeof block.text === "string") {
                try {
                  // Unwrap any extra text block wrapping from clients
                  const unwrapped = unwrapToolContent(block.text);
                  // Try to parse as JSON
                  const parsed = JSON.parse(unwrapped);
                  const noncompressed = unwrapped;
                  const compressed = toonEncode(parsed);

                  // Count tokens for before and after
                  const tokensBefore = tokenizer.countTokens([
                    { role: "user", content: noncompressed },
                  ]);
                  const tokensAfter = tokenizer.countTokens([
                    { role: "user", content: compressed },
                  ]);

                  // Track compression stats in tokens
                  totalTokensBefore += tokensBefore;
                  totalTokensAfter += tokensAfter;

                  logger.info(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      beforeLength: noncompressed.length,
                      afterLength: compressed.length,
                      tokensBefore,
                      tokensAfter,
                      toonPreview: compressed.substring(0, 150),
                    },
                    "convertToolResultsToToon: compressed (array content)",
                  );
                  logger.debug(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      before: noncompressed,
                      after: compressed,
                      provider: "anthropic",
                      supposedToBeJson: parsed,
                    },
                    "convertToolResultsToToon: before/after",
                  );

                  return {
                    ...block,
                    text: compressed,
                  };
                } catch {
                  // Not JSON, keep as-is
                  logger.info(
                    {
                      toolCallId: contentBlock.tool_use_id,
                      blockType: block.type,
                      textPreview: block.text?.substring(0, 100),
                    },
                    "convertToolResultsToToon: skipping - content is not JSON",
                  );
                  return block;
                }
              }
              return block;
            });

            return {
              ...contentBlock,
              content: updatedBlocks,
            };
          }
        }
        return contentBlock;
      });

      return {
        ...message,
        content: updatedContent,
      };
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
// ADAPTER FACTORY
// =============================================================================

export const anthropicAdapterFactory: LLMProvider<
  AnthropicRequest,
  AnthropicResponse,
  AnthropicMessages,
  AnthropicStreamChunk,
  AnthropicHeaders
> = {
  provider: "anthropic",
  interactionType: "anthropic:messages",

  createRequestAdapter(
    request: AnthropicRequest,
  ): LLMRequestAdapter<AnthropicRequest, AnthropicMessages> {
    return new AnthropicRequestAdapter(request);
  },

  createResponseAdapter(
    response: AnthropicResponse,
  ): LLMResponseAdapter<AnthropicResponse> {
    return new AnthropicResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    AnthropicStreamChunk,
    AnthropicResponse
  > {
    return new AnthropicStreamAdapter();
  },

  extractApiKey(headers: AnthropicHeaders): string | undefined {
    return headers["x-api-key"];
  },

  getBaseUrl(): string | undefined {
    return config.llm.anthropic.baseUrl;
  },

  getSpanName(): string {
    return "anthropic.messages";
  },

  createClient(
    apiKey: string | undefined,
    options?: { baseUrl?: string; fetch?: typeof fetch; mockMode?: boolean },
  ): AnthropicProvider {
    if (options?.mockMode) {
      return new MockAnthropicClient() as unknown as AnthropicProvider;
    }
    return new AnthropicProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: options?.fetch,
    });
  },

  async execute(
    client: unknown,
    request: AnthropicRequest,
  ): Promise<AnthropicResponse> {
    const anthropicClient = client as AnthropicProvider;
    return anthropicClient.messages.create({
      ...request,
      stream: false,
    } as AnthropicProvider.Messages.MessageCreateParamsNonStreaming);
  },

  async executeStream(
    client: unknown,
    request: AnthropicRequest,
  ): Promise<AsyncIterable<AnthropicStreamChunk>> {
    const anthropicClient = client as AnthropicProvider;
    const stream = anthropicClient.messages.stream({
      ...request,
    } as AnthropicProvider.Messages.MessageCreateParamsStreaming);

    // Return async iterable that yields stream events
    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const event of stream) {
          yield event;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // Anthropic SDK wraps errors as: { error: { error: { message: "..." } } }
    const anthropicMessage = get(error, "error.error.message");
    if (typeof anthropicMessage === "string") {
      return anthropicMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
