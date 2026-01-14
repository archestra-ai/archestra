import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ConverseStreamOutput,
  type ContentBlock,
  type Message,
  type ToolResultContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { encode as toonEncode } from "@toon-format/toon";
import config from "@/config";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  Bedrock,
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

// =============================================================================
// TYPE ALIASES
// =============================================================================

type BedrockRequest = Bedrock.Types.ConverseRequest;
type BedrockResponse = Bedrock.Types.ConverseResponse;
type BedrockMessages = Bedrock.Types.Message[];
type BedrockHeaders = Bedrock.Types.ConverseHeaders;

// Stream event types from the SDK
type BedrockStreamEvent = ConverseStreamOutput;

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if a content block is a text block
 */
function isTextBlock(block: ContentBlock): block is ContentBlock.TextMember {
  return "text" in block && typeof block.text === "string";
}

/**
 * Check if a content block is a tool use block
 */
function isToolUseBlock(block: ContentBlock): block is ContentBlock.ToolUseMember {
  return "toolUse" in block && block.toolUse !== undefined;
}

/**
 * Check if a content block is a tool result block
 */
function isToolResultBlock(block: ContentBlock): block is ContentBlock.ToolResultMember {
  return "toolResult" in block && block.toolResult !== undefined;
}

/**
 * Generate a unique message ID for Bedrock responses
 */
function generateMessageId(): string {
  return `msg_bedrock_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class BedrockRequestAdapter
  implements LLMRequestAdapter<BedrockRequest, BedrockMessages>
{
  readonly provider = "bedrock" as const;
  private request: BedrockRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: BedrockRequest) {
    this.request = request;
  }

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  getModel(): string {
    return this.modifiedModel ?? this.request.modelId;
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
          if ("toolResult" in contentBlock && contentBlock.toolResult) {
            const toolResult = contentBlock.toolResult;
            const toolUseId = toolResult.toolUseId ?? "";
            // Find tool name from previous assistant messages
            const toolName = this.findToolName(toolUseId);

            let content: unknown;
            // Extract content from tool result
            if (toolResult.content && toolResult.content.length > 0) {
              const firstContent = toolResult.content[0];
              if ("text" in firstContent && firstContent.text) {
                try {
                  content = JSON.parse(firstContent.text);
                } catch {
                  content = firstContent.text;
                }
              } else if ("json" in firstContent) {
                content = firstContent.json;
              } else {
                content = firstContent;
              }
            }

            results.push({
              id: toolUseId,
              name: toolName ?? "unknown",
              content,
              isError: toolResult.status === "error",
            });
          }
        }
      }
    }

    return results;
  }

  getTools(): CommonMcpToolDefinition[] {
    if (!this.request.toolConfig?.tools) return [];

    return this.request.toolConfig.tools.map((tool) => ({
      name: tool.toolSpec?.name ?? "",
      description: tool.toolSpec?.description,
      inputSchema: (tool.toolSpec?.inputSchema?.json ?? {}) as Record<string, unknown>,
    }));
  }

  hasTools(): boolean {
    return (this.request.toolConfig?.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): BedrockMessages {
    return this.request.messages;
  }

  getOriginalRequest(): BedrockRequest {
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

  convertToolResultContent(messages: BedrockMessages): BedrockMessages {
    // Bedrock uses a different format for images, no conversion needed for now
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): BedrockRequest {
    let messages = this.request.messages;

    // Apply tool result updates if any
    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = this.applyUpdates(messages, this.toolResultUpdates);
    }

    return {
      ...this.request,
      modelId: this.getModel(),
      messages,
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

  private findToolName(toolUseId: string): string | null {
    for (let i = this.request.messages.length - 1; i >= 0; i--) {
      const message = this.request.messages[i];
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const content of message.content) {
          if ("toolUse" in content && content.toolUse?.toolUseId === toolUseId) {
            return content.toolUse.name ?? null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Convert Bedrock messages to common format for policy evaluation
   */
  private toCommonFormat(messages: BedrockMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[BedrockAdapter] toCommonFormat: starting conversion",
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
          if ("toolResult" in contentBlock && contentBlock.toolResult) {
            const toolResult = contentBlock.toolResult;
            const toolUseId = toolResult.toolUseId ?? "";
            const toolName = this.findToolNameInMessages(messages, toolUseId);

            if (toolName) {
              logger.debug(
                { toolUseId, toolName },
                "[BedrockAdapter] toCommonFormat: found tool result",
              );

              let parsedResult: unknown;
              if (toolResult.content && toolResult.content.length > 0) {
                const firstContent = toolResult.content[0];
                if ("text" in firstContent && firstContent.text) {
                  try {
                    parsedResult = JSON.parse(firstContent.text);
                  } catch {
                    parsedResult = firstContent.text;
                  }
                } else if ("json" in firstContent) {
                  parsedResult = firstContent.json;
                }
              }

              toolCalls.push({
                id: toolUseId,
                name: toolName,
                content: parsedResult,
                isError: false,
              });
            }
          }
        }

        if (toolCalls.length > 0) {
          commonMessage.toolCalls = toolCalls;
          logger.debug(
            { toolCallCount: toolCalls.length },
            "[BedrockAdapter] toCommonFormat: attached tool calls to message",
          );
        }
      }

      commonMessages.push(commonMessage);
    }

    logger.debug(
      { inputCount: messages.length, outputCount: commonMessages.length },
      "[BedrockAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  /**
   * Extract tool name from messages by finding the assistant message
   * that contains the tool_use_id
   */
  private findToolNameInMessages(
    messages: BedrockMessages,
    toolUseId: string,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const content of message.content) {
          if ("toolUse" in content && content.toolUse?.toolUseId === toolUseId) {
            return content.toolUse.name ?? null;
          }
        }
      }
    }
    return null;
  }

  /**
   * Apply tool result updates back to Bedrock messages
   */
  private applyUpdates(
    messages: BedrockMessages,
    updates: Record<string, string>,
  ): BedrockMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[BedrockAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[BedrockAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      // Only process user messages with content arrays
      if (message.role === "user" && Array.isArray(message.content)) {
        const updatedContent = message.content.map((contentBlock) => {
          if (
            "toolResult" in contentBlock &&
            contentBlock.toolResult &&
            contentBlock.toolResult.toolUseId &&
            updates[contentBlock.toolResult.toolUseId]
          ) {
            appliedCount++;
            logger.debug(
              { toolUseId: contentBlock.toolResult.toolUseId },
              "[BedrockAdapter] applyUpdates: applying update to tool result",
            );
            return {
              toolResult: {
                ...contentBlock.toolResult,
                content: [{ text: updates[contentBlock.toolResult.toolUseId] }],
              },
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
      "[BedrockAdapter] applyUpdates: complete",
    );
    return result as BedrockMessages;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class BedrockResponseAdapter
  implements LLMResponseAdapter<BedrockResponse>
{
  readonly provider = "bedrock" as const;
  private response: BedrockResponse;
  private messageId: string;

  constructor(response: BedrockResponse) {
    this.response = response;
    this.messageId = response.$metadata?.requestId ?? generateMessageId();
  }

  getId(): string {
    return this.messageId;
  }

  getModel(): string {
    // Bedrock doesn't return the model in response, return empty string
    // The caller should track which model was used
    return "";
  }

  getText(): string {
    const outputMessage = this.response.output?.message;
    if (!outputMessage?.content) return "";

    const textBlocks = outputMessage.content.filter(
      (block): block is { text: string } => "text" in block && typeof block.text === "string",
    );
    return textBlocks.map((block) => block.text).join("");
  }

  getToolCalls(): CommonToolCall[] {
    const outputMessage = this.response.output?.message;
    if (!outputMessage?.content) return [];

    const toolCalls: CommonToolCall[] = [];
    for (const block of outputMessage.content) {
      if ("toolUse" in block && block.toolUse) {
        const toolUse = block.toolUse as { toolUseId?: string; name?: string; input?: Record<string, unknown> };
        toolCalls.push({
          id: toolUse.toolUseId ?? "",
          name: toolUse.name ?? "",
          arguments: (toolUse.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return toolCalls;
  }

  hasToolCalls(): boolean {
    const outputMessage = this.response.output?.message;
    if (!outputMessage?.content) return false;

    return outputMessage.content.some((block) => "toolUse" in block);
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.usage?.inputTokens ?? 0,
      outputTokens: this.response.usage?.outputTokens ?? 0,
    };
  }

  getOriginalResponse(): BedrockResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): BedrockResponse {
    return {
      ...this.response,
      output: {
        message: {
          role: "assistant",
          content: [{ text: contentMessage }],
        },
      },
      stopReason: "end_turn",
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class BedrockStreamAdapter
  implements LLMStreamAdapter<BedrockStreamEvent, BedrockResponse>
{
  readonly provider = "bedrock" as const;
  readonly state: StreamAccumulatorState;
  private currentToolCallIndex = -1;

  constructor() {
    this.state = {
      responseId: generateMessageId(),
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

  processChunk(chunk: BedrockStreamEvent): ChunkProcessingResult {
    // Track first chunk time
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Process different event types from Bedrock stream
    if ("messageStart" in chunk && chunk.messageStart) {
      // Message started
      sseData = `event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: {
          id: this.state.responseId,
          role: "assistant",
          model: this.state.model,
        },
      })}\n\n`;
    } else if ("contentBlockStart" in chunk && chunk.contentBlockStart) {
      const blockStart = chunk.contentBlockStart;
      if (blockStart.start && "toolUse" in blockStart.start && blockStart.start.toolUse) {
        // Tool use block started
        const toolUse = blockStart.start.toolUse;
        this.currentToolCallIndex = this.state.toolCalls.length;
        this.state.toolCalls.push({
          id: toolUse.toolUseId ?? "",
          name: toolUse.name ?? "",
          arguments: "",
        });
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      } else {
        // Text block started
        sseData = `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockStart.contentBlockIndex ?? 0,
          content_block: { type: "text", text: "" },
        })}\n\n`;
      }
    } else if ("contentBlockDelta" in chunk && chunk.contentBlockDelta) {
      const blockDelta = chunk.contentBlockDelta;
      if (blockDelta.delta && "text" in blockDelta.delta && blockDelta.delta.text) {
        // Text delta
        this.state.text += blockDelta.delta.text;
        sseData = `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockDelta.contentBlockIndex ?? 0,
          delta: {
            type: "text_delta",
            text: blockDelta.delta.text,
          },
        })}\n\n`;
      } else if (blockDelta.delta && "toolUse" in blockDelta.delta && blockDelta.delta.toolUse) {
        // Tool use delta (input JSON)
        const toolUseDelta = blockDelta.delta.toolUse;
        if (this.currentToolCallIndex >= 0 && toolUseDelta.input) {
          this.state.toolCalls[this.currentToolCallIndex].arguments +=
            toolUseDelta.input;
        }
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      }
    } else if ("contentBlockStop" in chunk && chunk.contentBlockStop) {
      // Content block ended
      const isToolBlock = this.state.toolCalls.length > 0 &&
        this.currentToolCallIndex === this.state.toolCalls.length - 1;

      if (isToolBlock) {
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      } else {
        sseData = `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: chunk.contentBlockStop.contentBlockIndex ?? 0,
        })}\n\n`;
      }
    } else if ("messageStop" in chunk && chunk.messageStop) {
      // Message ended
      this.state.stopReason = chunk.messageStop.stopReason ?? "end_turn";
      isFinal = true;
    } else if ("metadata" in chunk && chunk.metadata) {
      // Usage information
      if (chunk.metadata.usage) {
        this.state.usage = {
          inputTokens: chunk.metadata.usage.inputTokens ?? 0,
          outputTokens: chunk.metadata.usage.outputTokens ?? 0,
        };
      }
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
    return this.state.rawToolCallEvents.map((event) => {
      const typedEvent = event as BedrockStreamEvent;
      // Convert Bedrock events to Anthropic-like SSE format
      if ("contentBlockStart" in typedEvent && typedEvent.contentBlockStart?.start && "toolUse" in typedEvent.contentBlockStart.start) {
        const toolUse = typedEvent.contentBlockStart.start.toolUse;
        return `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: typedEvent.contentBlockStart.contentBlockIndex ?? 0,
          content_block: {
            type: "tool_use",
            id: toolUse?.toolUseId,
            name: toolUse?.name,
            input: {},
          },
        })}\n\n`;
      }
      if ("contentBlockDelta" in typedEvent && typedEvent.contentBlockDelta?.delta && "toolUse" in typedEvent.contentBlockDelta.delta) {
        return `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: typedEvent.contentBlockDelta.contentBlockIndex ?? 0,
          delta: {
            type: "input_json_delta",
            partial_json: typedEvent.contentBlockDelta.delta.toolUse?.input ?? "",
          },
        })}\n\n`;
      }
      if ("contentBlockStop" in typedEvent && typedEvent.contentBlockStop) {
        return `event: content_block_stop\ndata: ${JSON.stringify({
          type: "content_block_stop",
          index: typedEvent.contentBlockStop.contentBlockIndex ?? 0,
        })}\n\n`;
      }
      return "";
    });
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

  toProviderResponse(): BedrockResponse {
    const content: Array<{ text: string } | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }> = [];

    // Add text block if we have text
    if (this.state.text) {
      content.push({ text: this.state.text });
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
        toolUse: {
          toolUseId: toolCall.id,
          name: toolCall.name,
          input: parsedInput,
        },
      });
    }

    return {
      $metadata: {
        requestId: this.state.responseId,
      },
      output: {
        message: {
          role: "assistant",
          content,
        },
      },
      stopReason: (this.state.stopReason as BedrockResponse["stopReason"]) ?? "end_turn",
      usage: {
        inputTokens: this.state.usage?.inputTokens ?? 0,
        outputTokens: this.state.usage?.outputTokens ?? 0,
      },
    };
  }
}

// =============================================================================
// TOON COMPRESSION
// =============================================================================

/**
 * Convert tool results in messages to TOON format
 * Returns both the converted messages and compression stats
 */
export async function convertToolResultsToToon(
  messages: BedrockMessages,
  model: string,
): Promise<{
  messages: BedrockMessages;
  stats: CompressionStats;
}> {
  // Use anthropic tokenizer as a reasonable approximation for Bedrock models
  const tokenizer = getTokenizer("anthropic");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    // Only process user messages with content arrays that contain tool_result blocks
    if (message.role === "user" && Array.isArray(message.content)) {
      const updatedContent = message.content.map((contentBlock) => {
        if (
          "toolResult" in contentBlock &&
          contentBlock.toolResult &&
          contentBlock.toolResult.status !== "error"
        ) {
          toolResultCount++;
          const toolResult = contentBlock.toolResult;

          // Handle content array
          if (toolResult.content && toolResult.content.length > 0) {
            const firstContent = toolResult.content[0];

            if ("text" in firstContent && typeof firstContent.text === "string") {
              try {
                const parsed = JSON.parse(firstContent.text);
                const noncompressed = firstContent.text;
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
                    toolUseId: toolResult.toolUseId,
                    beforeLength: noncompressed.length,
                    afterLength: compressed.length,
                    tokensBefore,
                    tokensAfter,
                    provider: "bedrock",
                  },
                  "convertToolResultsToToon: compressed",
                );

                return {
                  toolResult: {
                    ...toolResult,
                    content: [{ text: compressed }],
                  },
                };
              } catch {
                logger.info(
                  {
                    toolUseId: toolResult.toolUseId,
                  },
                  "convertToolResultsToToon: skipping - content is not JSON",
                );
                return contentBlock;
              }
            } else if ("json" in firstContent && firstContent.json) {
              try {
                const noncompressed = JSON.stringify(firstContent.json);
                const compressed = toonEncode(firstContent.json);

                const tokensBefore = tokenizer.countTokens([
                  { role: "user", content: noncompressed },
                ]);
                const tokensAfter = tokenizer.countTokens([
                  { role: "user", content: compressed },
                ]);
                totalTokensBefore += tokensBefore;
                totalTokensAfter += tokensAfter;

                return {
                  toolResult: {
                    ...toolResult,
                    content: [{ text: compressed }],
                  },
                };
              } catch {
                return contentBlock;
              }
            }
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
  }) as BedrockMessages;

  logger.info(
    { messageCount: messages.length, toolResultCount },
    "convertToolResultsToToon completed for Bedrock",
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

export const bedrockAdapterFactory: LLMProvider<
  BedrockRequest,
  BedrockResponse,
  BedrockMessages,
  BedrockStreamEvent,
  BedrockHeaders
> = {
  provider: "bedrock",
  interactionType: "bedrock:converse",

  createRequestAdapter(
    request: BedrockRequest,
  ): LLMRequestAdapter<BedrockRequest, BedrockMessages> {
    return new BedrockRequestAdapter(request);
  },

  createResponseAdapter(
    response: BedrockResponse,
  ): LLMResponseAdapter<BedrockResponse> {
    return new BedrockResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<BedrockStreamEvent, BedrockResponse> {
    return new BedrockStreamAdapter();
  },

  extractApiKey(headers: BedrockHeaders): string | undefined {
    // Bedrock uses AWS credentials, not a simple API key
    // Return a composite string that includes access key, secret, and optionally session token
    const accessKeyId = headers["x-amz-access-key-id"];
    const secretAccessKey = headers["x-amz-secret-access-key"];
    const sessionToken = headers["x-amz-session-token"];
    const region = headers["x-amz-region"];

    if (accessKeyId && secretAccessKey) {
      // Format: accessKeyId:secretAccessKey:sessionToken:region
      const parts = [accessKeyId, secretAccessKey];
      if (sessionToken) parts.push(sessionToken);
      else parts.push("");
      if (region) parts.push(region);
      return parts.join(":");
    }

    // Fall back to Authorization header if present
    if (headers.authorization?.startsWith("AWS4-HMAC-SHA256")) {
      return headers.authorization;
    }

    return undefined;
  },

  getBaseUrl(): string | undefined {
    // Bedrock uses regional endpoints, not a single base URL
    return undefined;
  },

  getSpanName(streaming: boolean): string {
    return streaming ? "bedrock.converse.stream" : "bedrock.converse";
  },

  createClient(
    apiKey: string | undefined,
    _options?: CreateClientOptions,
  ): BedrockRuntimeClient {
    // Parse credentials from the composite API key string
    let accessKeyId: string | undefined;
    let secretAccessKey: string | undefined;
    let sessionToken: string | undefined;
    let region = config.llm.bedrock.region;

    if (apiKey) {
      const parts = apiKey.split(":");
      if (parts.length >= 2) {
        accessKeyId = parts[0];
        secretAccessKey = parts[1];
        if (parts.length >= 3 && parts[2]) {
          sessionToken = parts[2];
        }
        if (parts.length >= 4 && parts[3]) {
          region = parts[3];
        }
      }
    }

    // Fall back to config if no credentials provided
    if (!accessKeyId) {
      accessKeyId = config.chat.bedrock.accessKeyId;
    }
    if (!secretAccessKey) {
      secretAccessKey = config.chat.bedrock.secretAccessKey;
    }
    if (!sessionToken && config.chat.bedrock.sessionToken) {
      sessionToken = config.chat.bedrock.sessionToken;
    }

    const clientConfig: {
      region: string;
      credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
        sessionToken?: string;
      };
    } = {
      region,
    };

    // Only set credentials if we have them, otherwise use default credential chain
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
      };
      if (sessionToken) {
        clientConfig.credentials.sessionToken = sessionToken;
      }
    }

    return new BedrockRuntimeClient(clientConfig);
  },

  async execute(
    client: unknown,
    request: BedrockRequest,
  ): Promise<BedrockResponse> {
    const bedrockClient = client as BedrockRuntimeClient;

    // Convert request to Bedrock Converse command format
    // Using type assertions to handle AWS SDK complex union types
    const commandInput = {
      modelId: request.modelId,
      messages: request.messages,
      system: request.system?.map((s) => {
        if ("text" in s) return { text: s.text };
        return s;
      }),
      inferenceConfig: request.inferenceConfig,
      toolConfig: request.toolConfig ? {
        tools: request.toolConfig.tools?.map((t) => ({
          toolSpec: t.toolSpec ? {
            name: t.toolSpec.name,
            description: t.toolSpec.description,
            inputSchema: t.toolSpec.inputSchema ? {
              json: t.toolSpec.inputSchema.json,
            } : undefined,
          } : undefined,
        })),
        toolChoice: request.toolConfig.toolChoice,
      } : undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const command = new ConverseCommand(commandInput as any);

    const response = await bedrockClient.send(command);

    // Convert response to our internal format
    const outputContent: Array<{ text: string } | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }> = [];
    if (response.output?.message?.content) {
      for (const c of response.output.message.content) {
        if ("text" in c && c.text) {
          outputContent.push({ text: c.text });
        } else if ("toolUse" in c && c.toolUse) {
          outputContent.push({
            toolUse: {
              toolUseId: c.toolUse.toolUseId ?? "",
              name: c.toolUse.name ?? "",
              input: (c.toolUse.input ?? {}) as Record<string, unknown>,
            },
          });
        }
      }
    }

    return {
      $metadata: response.$metadata,
      output: {
        message: response.output?.message ? {
          role: "assistant",
          content: outputContent,
        } : undefined,
      },
      stopReason: response.stopReason as BedrockResponse["stopReason"],
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
      metrics: response.metrics,
      additionalModelResponseFields: response.additionalModelResponseFields as Record<string, unknown> | undefined,
      trace: response.trace,
    };
  },

  async executeStream(
    client: unknown,
    request: BedrockRequest,
  ): Promise<AsyncIterable<BedrockStreamEvent>> {
    const bedrockClient = client as BedrockRuntimeClient;

    // Convert request to Bedrock ConverseStream command format
    // Using type assertions to handle AWS SDK complex union types
    const commandInput = {
      modelId: request.modelId,
      messages: request.messages,
      system: request.system?.map((s) => {
        if ("text" in s) return { text: s.text };
        return s;
      }),
      inferenceConfig: request.inferenceConfig,
      toolConfig: request.toolConfig ? {
        tools: request.toolConfig.tools?.map((t) => ({
          toolSpec: t.toolSpec ? {
            name: t.toolSpec.name,
            description: t.toolSpec.description,
            inputSchema: t.toolSpec.inputSchema ? {
              json: t.toolSpec.inputSchema.json,
            } : undefined,
          } : undefined,
        })),
        toolChoice: request.toolConfig.toolChoice,
      } : undefined,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const command = new ConverseStreamCommand(commandInput as any);

    const response = await bedrockClient.send(command);

    // Return async iterable that yields stream events
    return {
      [Symbol.asyncIterator]: async function* () {
        if (response.stream) {
          for await (const event of response.stream) {
            yield event;
          }
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // Handle AWS SDK error format
    if (error && typeof error === "object") {
      const awsError = error as { message?: string; $metadata?: { httpStatusCode?: number }; name?: string };
      if (awsError.message) {
        return awsError.message;
      }
      if (awsError.name) {
        return `AWS Error: ${awsError.name}`;
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
