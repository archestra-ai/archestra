import type { ConverseStreamOutput } from "@aws-sdk/client-bedrock-runtime";
import { EventStreamCodec } from "@smithy/eventstream-codec";
import { fromUtf8, toUtf8 } from "@smithy/util-utf8";
import { encode as toonEncode } from "@toon-format/toon";
import { BedrockClient } from "@/clients/bedrock-client";
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
  ToolCompressionStats,
  UsageView,
} from "@/types";

// ToolCompressionStats imported from @/types

// =============================================================================
// TYPE ALIASES
// =============================================================================

type BedrockRequest = Bedrock.Types.ConverseRequest;
type BedrockResponse = Bedrock.Types.ConverseResponse;
type BedrockMessages = Bedrock.Types.Message[];
type BedrockHeaders = Bedrock.Types.ConverseHeaders;

// Stream event types from the SDK
type BedrockStreamEvent = ConverseStreamOutput;

// Extended event type that includes raw bytes for passthrough
type BedrockStreamEventWithRaw = BedrockStreamEvent & {
  __rawBytes?: Uint8Array;
};

// Event stream codec for binary encoding/decoding
const eventStreamCodec = new EventStreamCodec(toUtf8, fromUtf8);

// Padding alphabet used by Bedrock (lowercase + uppercase + digits)
const PADDING_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate padding string to match Bedrock's format.
 * Uses a prefix of the alphabet, with length to reach target body size.
 */
function generatePadding(currentBodyLength: number, targetSize = 80): string {
  const paddingNeeded = Math.max(0, targetSize - currentBodyLength - 10); // -10 for `,"p":""`
  return PADDING_ALPHABET.slice(
    0,
    Math.min(paddingNeeded, PADDING_ALPHABET.length),
  );
}

/**
 * Encode an event to AWS Event Stream binary format.
 * Adds padding field "p" to match Bedrock's format.
 */
function encodeEventStreamMessage(
  eventType: string,
  body: unknown,
): Uint8Array {
  // Add padding to match Bedrock's format
  const bodyWithoutPadding = JSON.stringify(body);
  const padding = generatePadding(bodyWithoutPadding.length);
  const bodyWithPadding = { ...(body as Record<string, unknown>), p: padding };
  const bodyJson = JSON.stringify(bodyWithPadding);
  const bodyBytes = fromUtf8(bodyJson);

  return eventStreamCodec.encode({
    headers: {
      ":event-type": { type: "string", value: eventType },
      ":content-type": { type: "string", value: "application/json" },
      ":message-type": { type: "string", value: "event" },
    },
    body: bodyBytes,
  });
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if the model is a Nova model (requires tool name encoding).
 */
function isNovaModel(modelId: string): boolean {
  return modelId.toLowerCase().includes("nova");
}

/**
 * Nova models faeil with "Model produced invalid sequence as part of ToolUse" when
 * tool names contain hyphens. We replace hyphens with underscores before sending
 * to Bedrock and use a name mapping to restore original names in responses.
 */
function encodeToolName(name: string): string {
  return name.replaceAll("-", "_");
}

/**
 * Build a mapping from encoded tool names back to original names.
 */
function buildToolNameMapping(request: BedrockRequest): Map<string, string> {
  const mapping = new Map<string, string>();
  const tools = request.toolConfig?.tools ?? [];
  for (const tool of tools) {
    const originalName = tool.toolSpec?.name;
    if (originalName) {
      const encodedName = encodeToolName(originalName);
      mapping.set(encodedName, originalName);
    }
  }
  return mapping;
}

/**
 * Decode tool name using the mapping (encoded → original).
 */
function decodeToolName(
  encodedName: string,
  mapping: Map<string, string>,
): string {
  return mapping.get(encodedName) ?? encodedName;
}

/**
 * Check if a content block is a text block.
 * Works with both AWS SDK ContentBlock and our internal Zod types.
 */
function isTextBlock(block: unknown): block is { text: string } {
  return (
    typeof block === "object" &&
    block !== null &&
    "text" in block &&
    typeof (block as { text: unknown }).text === "string"
  );
}

/**
 * Check if a content block is a tool use block.
 * Works with both AWS SDK ContentBlock and our internal Zod types.
 */
function isToolUseBlock(block: unknown): block is {
  toolUse: { toolUseId?: string; name?: string; input?: unknown };
} {
  return (
    typeof block === "object" &&
    block !== null &&
    "toolUse" in block &&
    (block as { toolUse: unknown }).toolUse !== undefined
  );
}

/**
 * Check if a content block is a tool result block.
 * Works with both AWS SDK ContentBlock and our internal Zod types.
 */
function isToolResultBlock(block: unknown): block is {
  toolResult: { toolUseId?: string; content?: unknown[]; status?: string };
} {
  return (
    typeof block === "object" &&
    block !== null &&
    "toolResult" in block &&
    (block as { toolResult: unknown }).toolResult !== undefined
  );
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
  private toolNameMapping: Map<string, string>;

  constructor(request: BedrockRequest) {
    this.request = request;
    // Only build mapping for Nova models (which require tool name encoding)
    this.toolNameMapping = isNovaModel(request.modelId)
      ? buildToolNameMapping(request)
      : new Map();
  }

  // ---------------------------------------------------------------------------
  // Read Access
  // ---------------------------------------------------------------------------

  getModel(): string {
    return this.modifiedModel ?? this.request.modelId;
  }

  isStreaming(): boolean {
    // Check _isStreaming flag injected by routes based on endpoint URL
    // (converse-stream endpoints set _isStreaming: true, converse endpoints set _isStreaming: false)
    return this.request._isStreaming === true;
  }

  getMessages(): CommonMessage[] {
    return this.toCommonFormat(this.request.messages ?? []);
  }

  getToolResults(): CommonToolResult[] {
    const results: CommonToolResult[] = [];

    for (const message of this.request.messages ?? []) {
      if (message.role === "user" && Array.isArray(message.content)) {
        for (const contentBlock of message.content) {
          if (isToolResultBlock(contentBlock)) {
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
      inputSchema: (tool.toolSpec?.inputSchema?.json ?? {}) as Record<
        string,
        unknown
      >,
    }));
  }

  hasTools(): boolean {
    return (this.request.toolConfig?.tools?.length ?? 0) > 0;
  }

  getProviderMessages(): BedrockMessages {
    return this.request.messages ?? [];
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

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages ?? [], model);
    // Update internal messages state
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return stats;
  }

  convertToolResultContent(messages: BedrockMessages): BedrockMessages {
    // Bedrock uses a different format for images, no conversion needed for now
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): BedrockRequest {
    let messages = this.request.messages ?? [];

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
    const messages = this.request.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant" && Array.isArray(message.content)) {
        for (const content of message.content) {
          if (
            isToolUseBlock(content) &&
            content.toolUse.toolUseId === toolUseId
          ) {
            const name = content.toolUse.name ?? null;
            return name ? decodeToolName(name, this.toolNameMapping) : null;
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
          if (isToolResultBlock(contentBlock)) {
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
          if (
            isToolUseBlock(content) &&
            content.toolUse.toolUseId === toolUseId
          ) {
            const name = content.toolUse.name ?? null;
            return name ? decodeToolName(name, this.toolNameMapping) : null;
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
            isToolResultBlock(contentBlock) &&
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

class BedrockResponseAdapter implements LLMResponseAdapter<BedrockResponse> {
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

    const textBlocks = outputMessage.content.filter(isTextBlock);
    return textBlocks.map((block) => block.text).join("");
  }

  getToolCalls(): CommonToolCall[] {
    const outputMessage = this.response.output?.message;
    if (!outputMessage?.content) return [];

    const toolCalls: CommonToolCall[] = [];
    for (const block of outputMessage.content) {
      if (isToolUseBlock(block)) {
        toolCalls.push({
          id: block.toolUse.toolUseId ?? "",
          // Tool names are already decoded by execute() before response reaches here
          name: block.toolUse.name ?? "",
          arguments: (block.toolUse.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return toolCalls;
  }

  hasToolCalls(): boolean {
    const outputMessage = this.response.output?.message;
    if (!outputMessage?.content) return false;

    return outputMessage.content.some(isToolUseBlock);
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
  private toolNameMapping: Map<string, string> = new Map();

  // Bedrock-specific extended state
  private bedrockState: {
    latencyMs: number | null;
    trace: unknown | null;
    // Buffer for messageStop and metadata events when tool calls are pending
    // These must be sent AFTER tool call events in the correct stream order
    pendingFinalEvents: BedrockStreamEventWithRaw[];
  };

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
    this.bedrockState = {
      latencyMs: null,
      trace: null,
      pendingFinalEvents: [],
    };
  }

  /**
   * Set the tool name mapping from the request for decoding tool names in responses.
   * Only builds mapping for Nova models (which require tool name encoding).
   */
  setToolNameMapping(request: BedrockRequest): void {
    if (isNovaModel(request.modelId)) {
      this.toolNameMapping = buildToolNameMapping(request);
    }
  }

  processChunk(chunk: BedrockStreamEventWithRaw): ChunkProcessingResult {
    // Track first chunk time
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: Uint8Array | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    // Use raw bytes if available (passthrough from Bedrock), otherwise re-encode
    const rawBytes = chunk.__rawBytes;

    // Process based on event type
    if ("messageStart" in chunk && chunk.messageStart) {
      sseData =
        rawBytes ??
        encodeEventStreamMessage("messageStart", chunk.messageStart);
    } else if ("contentBlockStart" in chunk && chunk.contentBlockStart) {
      const blockStart = chunk.contentBlockStart;
      if (
        blockStart.start &&
        "toolUse" in blockStart.start &&
        blockStart.start.toolUse
      ) {
        // Tool use block - buffer for policy evaluation
        const toolUse = blockStart.start.toolUse;
        this.currentToolCallIndex = this.state.toolCalls.length;
        this.state.toolCalls.push({
          id: toolUse.toolUseId ?? "",
          name: decodeToolName(toolUse.name ?? "", this.toolNameMapping),
          arguments: "",
        });
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      } else {
        sseData =
          rawBytes ??
          encodeEventStreamMessage(
            "contentBlockStart",
            chunk.contentBlockStart,
          );
      }
    } else if ("contentBlockDelta" in chunk && chunk.contentBlockDelta) {
      const blockDelta = chunk.contentBlockDelta;
      if (
        blockDelta.delta &&
        "text" in blockDelta.delta &&
        blockDelta.delta.text
      ) {
        this.state.text += blockDelta.delta.text;
        sseData =
          rawBytes ??
          encodeEventStreamMessage(
            "contentBlockDelta",
            chunk.contentBlockDelta,
          );
      } else if (
        blockDelta.delta &&
        "toolUse" in blockDelta.delta &&
        blockDelta.delta.toolUse
      ) {
        // Tool use delta - buffer for policy evaluation
        const toolUseDelta = blockDelta.delta.toolUse;
        if (this.currentToolCallIndex >= 0 && toolUseDelta.input) {
          this.state.toolCalls[this.currentToolCallIndex].arguments +=
            toolUseDelta.input;
        }
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      }
    } else if ("contentBlockStop" in chunk && chunk.contentBlockStop) {
      const isToolBlock =
        this.state.toolCalls.length > 0 &&
        this.currentToolCallIndex === this.state.toolCalls.length - 1;

      if (isToolBlock) {
        this.state.rawToolCallEvents.push(chunk);
        isToolCallChunk = true;
      } else {
        sseData =
          rawBytes ??
          encodeEventStreamMessage("contentBlockStop", chunk.contentBlockStop);
      }
    } else if ("messageStop" in chunk && chunk.messageStop) {
      this.state.stopReason = chunk.messageStop.stopReason ?? "end_turn";
      // If we have pending tool calls, buffer this event to send after tool blocks
      // The stream order must be: text blocks → tool blocks → messageStop → metadata
      if (this.state.toolCalls.length > 0) {
        this.bedrockState.pendingFinalEvents.push(chunk);
        isToolCallChunk = true; // Mark as tool-related so it's not streamed yet
      } else {
        sseData =
          rawBytes ??
          encodeEventStreamMessage("messageStop", chunk.messageStop);
      }
      // Don't set isFinal here - metadata chunk comes after messageStop
    } else if ("metadata" in chunk && chunk.metadata) {
      const metadata = chunk.metadata as {
        usage?: { inputTokens?: number; outputTokens?: number };
        metrics?: { latencyMs?: number };
        trace?: unknown;
      };
      if (metadata.usage) {
        this.state.usage = {
          inputTokens: metadata.usage.inputTokens ?? 0,
          outputTokens: metadata.usage.outputTokens ?? 0,
        };
      }
      if (metadata.metrics?.latencyMs !== undefined) {
        this.bedrockState.latencyMs = metadata.metrics.latencyMs;
      }
      if (metadata.trace) {
        this.bedrockState.trace = metadata.trace;
      }
      // If we have pending tool calls, buffer this event to send after tool blocks
      if (this.state.toolCalls.length > 0) {
        this.bedrockState.pendingFinalEvents.push(chunk);
        isToolCallChunk = true; // Mark as tool-related so it's not streamed yet
      } else {
        // Pass through metadata chunk as-is - this is the final event
        sseData =
          rawBytes ?? encodeEventStreamMessage("metadata", chunk.metadata);
      }
      isFinal = true;
    } else if (
      "internalServerException" in chunk &&
      chunk.internalServerException
    ) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: true,
        error: {
          type: "internal_server_error",
          message:
            chunk.internalServerException.message ?? "Internal server error",
        },
      };
    } else if (
      "modelStreamErrorException" in chunk &&
      chunk.modelStreamErrorException
    ) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: true,
        error: {
          type: "model_stream_error",
          message:
            chunk.modelStreamErrorException.message ?? "Model stream error",
        },
      };
    } else if (
      "serviceUnavailableException" in chunk &&
      chunk.serviceUnavailableException
    ) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: true,
        error: {
          type: "service_unavailable",
          message:
            chunk.serviceUnavailableException.message ?? "Service unavailable",
        },
      };
    } else if ("throttlingException" in chunk && chunk.throttlingException) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: true,
        error: {
          type: "throttling",
          message: chunk.throttlingException.message ?? "Request throttled",
        },
      };
    } else if ("validationException" in chunk && chunk.validationException) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: true,
        error: {
          type: "validation_error",
          message: chunk.validationException.message ?? "Validation error",
        },
      };
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/vnd.amazon.eventstream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "request-id": `req-proxy-${Date.now()}`,
    };
  }

  formatTextDeltaSSE(text: string): Uint8Array {
    // AWS Event Stream binary format
    return encodeEventStreamMessage("contentBlockDelta", {
      contentBlockIndex: 0,
      delta: { text },
    });
  }

  getRawToolCallEvents(): Uint8Array[] {
    const result: Uint8Array[] = [];

    // Re-encode all tool call content blocks with decoded tool names
    // We cannot use raw bytes because they contain encoded names (hyphens replaced with underscores)
    for (const rawEvent of this.state.rawToolCallEvents) {
      const event = rawEvent as BedrockStreamEventWithRaw;

      if ("contentBlockStart" in event && event.contentBlockStart) {
        const blockStart = event.contentBlockStart;
        // Decode tool name if this is a tool use block
        if (
          blockStart.start &&
          "toolUse" in blockStart.start &&
          blockStart.start.toolUse
        ) {
          const originalName = blockStart.start.toolUse.name ?? "";
          const decodedName = decodeToolName(
            originalName,
            this.toolNameMapping,
          );
          const decodedEvent = {
            ...blockStart,
            start: {
              toolUse: {
                ...blockStart.start.toolUse,
                name: decodedName,
              },
            },
          };
          result.push(
            encodeEventStreamMessage("contentBlockStart", decodedEvent),
          );
        } else {
          result.push(
            encodeEventStreamMessage(
              "contentBlockStart",
              event.contentBlockStart,
            ),
          );
        }
      } else if ("contentBlockDelta" in event && event.contentBlockDelta) {
        result.push(
          encodeEventStreamMessage(
            "contentBlockDelta",
            event.contentBlockDelta,
          ),
        );
      } else if ("contentBlockStop" in event && event.contentBlockStop) {
        result.push(
          encodeEventStreamMessage("contentBlockStop", event.contentBlockStop),
        );
      }
    }

    // Then, add the buffered final events (messageStop and metadata) in order
    // These must come AFTER all content blocks for correct stream order
    for (const finalEvent of this.bedrockState.pendingFinalEvents) {
      const event = finalEvent as BedrockStreamEventWithRaw;

      // Use original raw bytes if available (these don't contain tool names)
      if (event.__rawBytes) {
        result.push(event.__rawBytes);
        continue;
      }

      // Fallback to re-encoding
      if ("messageStop" in event && event.messageStop) {
        result.push(encodeEventStreamMessage("messageStop", event.messageStop));
      } else if ("metadata" in event && event.metadata) {
        result.push(encodeEventStreamMessage("metadata", event.metadata));
      }
    }

    return result;
  }

  formatCompleteTextSSE(text: string): Uint8Array[] {
    // AWS Event Stream binary format
    return [
      encodeEventStreamMessage("contentBlockStart", {
        contentBlockIndex: 0,
        start: { text: "" },
      }),
      encodeEventStreamMessage("contentBlockDelta", {
        contentBlockIndex: 0,
        delta: { text },
      }),
      encodeEventStreamMessage("contentBlockStop", {
        contentBlockIndex: 0,
      }),
    ];
  }

  formatEndSSE(): string {
    // All events (messageStop, metadata) are passed through in processChunk
    // Nothing additional needed here
    return "";
  }

  toProviderResponse(): BedrockResponse {
    const content: Array<
      | { text: string }
      | {
          toolUse: {
            toolUseId: string;
            name: string;
            input: Record<string, unknown>;
          };
        }
    > = [];

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

    // Build metrics if latency is available
    const metrics =
      this.bedrockState.latencyMs !== null
        ? { latencyMs: this.bedrockState.latencyMs }
        : undefined;

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
      stopReason:
        (this.state.stopReason as BedrockResponse["stopReason"]) ?? "end_turn",
      usage: {
        inputTokens: this.state.usage?.inputTokens ?? 0,
        outputTokens: this.state.usage?.outputTokens ?? 0,
      },
      metrics,
      trace: this.bedrockState.trace ?? undefined,
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
  stats: ToolCompressionStats;
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
          isToolResultBlock(contentBlock) &&
          contentBlock.toolResult.status !== "error"
        ) {
          toolResultCount++;
          const toolResult = contentBlock.toolResult;

          // Handle content array
          if (toolResult.content && toolResult.content.length > 0) {
            const firstContent = toolResult.content[0];

            if (
              "text" in firstContent &&
              typeof firstContent.text === "string"
            ) {
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
  let toonCostSavings = 0;
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
      tokensBefore: totalTokensBefore,
      tokensAfter: totalTokensAfter,
      costSavings: toonCostSavings,
      wasEffective: totalTokensAfter < totalTokensBefore,
      hadToolResults: toolResultCount > 0,
    },
  };
}

// =============================================================================
// HELPER: Build Command Input
// =============================================================================

/**
 * Convert BedrockRequest to AWS SDK command input format.
 * Used by both ConverseCommand and ConverseStreamCommand.
 * Only maps tool names for Nova models (which don't support hyphens).
 */
export function getCommandInput(request: BedrockRequest) {
  const shouldEncode = isNovaModel(request.modelId);

  return {
    modelId: request.modelId,
    messages: request.messages,
    system: request.system?.map((s) => {
      if ("text" in s) return { text: s.text };
      return s;
    }),
    inferenceConfig: request.inferenceConfig,
    toolConfig: request.toolConfig
      ? {
          tools: request.toolConfig.tools?.map((t) => ({
            toolSpec: t.toolSpec
              ? {
                  // Only encode hyphens for Nova models
                  name:
                    t.toolSpec.name && shouldEncode
                      ? encodeToolName(t.toolSpec.name)
                      : t.toolSpec.name,
                  description: t.toolSpec.description,
                  inputSchema: t.toolSpec.inputSchema
                    ? {
                        json: t.toolSpec.inputSchema.json,
                      }
                    : undefined,
                }
              : undefined,
          })),
          toolChoice: request.toolConfig.toolChoice,
        }
      : undefined,
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

  createStreamAdapter(
    request?: BedrockRequest,
  ): LLMStreamAdapter<BedrockStreamEvent, BedrockResponse> {
    const adapter = new BedrockStreamAdapter();
    if (request) {
      adapter.setToolNameMapping(request);
    }
    return adapter;
  },

  // TODO: currently extracts only bearer
  extractApiKey(headers: BedrockHeaders): string | undefined {
    // Extract Bearer token from Authorization header
    const authHeader = headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      return authHeader.slice(7);
    }
    return undefined;
  },

  getBaseUrl(): string | undefined {
    return config.llm.bedrock.baseUrl || undefined;
  },

  getSpanName(streaming: boolean): string {
    return streaming ? "bedrock.converse.stream" : "bedrock.converse";
  },

  createClient(
    apiKey: string | undefined,
    _options?: CreateClientOptions,
  ): BedrockClient {
    logger.info(
      { hasApiKey: !!apiKey, apiKeyLength: apiKey?.length },
      "[BedrockAdapter] createClient called",
    );
    const baseUrl = config.llm.bedrock.baseUrl;

    // Extract region from baseUrl (e.g., https://bedrock-runtime.us-east-1.amazonaws.com)
    // or use a default region
    const regionMatch = baseUrl.match(/bedrock-runtime\.([a-z0-9-]+)\./);
    const region = regionMatch?.[1] || "us-east-1";

    logger.info({ region }, "[BedrockAdapter] region extracted from baseUrl");
    logger.info({ endpoint: baseUrl }, "[BedrockAdapter] baseUrl");
    logger.info({ hasApiKey: !!apiKey }, "[BedrockAdapter] apiKey");

    // Create fetch-based client with Bearer token auth when apiKey is provided
    const client = new BedrockClient({
      baseUrl,
      region,
      apiKey,
    });

    return client;
  },

  async execute(
    client: unknown,
    request: BedrockRequest,
  ): Promise<BedrockResponse> {
    const bedrockClient = client as BedrockClient;
    const commandInput = getCommandInput(request);
    // Only build mapping for Nova models (which require tool name encoding)
    const toolNameMapping = isNovaModel(request.modelId)
      ? buildToolNameMapping(request)
      : new Map<string, string>();

    // Use fetch-based client.converse()
    const response = await bedrockClient.converse(
      request.modelId,
      commandInput,
    );

    // Convert response to our internal format with decoded tool names
    const outputContent: Array<
      | { text: string }
      | {
          toolUse: {
            toolUseId: string;
            name: string;
            input: Record<string, unknown>;
          };
        }
    > = [];
    if (response.output?.message?.content) {
      for (const c of response.output.message.content) {
        if (isTextBlock(c)) {
          outputContent.push({ text: c.text });
        } else if (isToolUseBlock(c)) {
          outputContent.push({
            toolUse: {
              toolUseId: c.toolUse.toolUseId ?? "",
              name: decodeToolName(c.toolUse.name ?? "", toolNameMapping),
              input: (c.toolUse.input ?? {}) as Record<string, unknown>,
            },
          });
        }
      }
    }

    return {
      $metadata: {
        requestId: response.$metadata?.requestId,
      },
      output: {
        message: response.output?.message
          ? {
              role: "assistant",
              content: outputContent,
            }
          : undefined,
      },
      stopReason: response.stopReason as BedrockResponse["stopReason"],
      usage: {
        inputTokens: response.usage?.inputTokens ?? 0,
        outputTokens: response.usage?.outputTokens ?? 0,
      },
      metrics: response.metrics,
      additionalModelResponseFields: response.additionalModelResponseFields as
        | Record<string, unknown>
        | undefined,
      trace: response.trace,
    };
  },

  async executeStream(
    client: unknown,
    request: BedrockRequest,
  ): Promise<AsyncIterable<BedrockStreamEventWithRaw>> {
    const bedrockClient = client as BedrockClient;
    const commandInput = getCommandInput(request);

    // Use fetch-based client.converseStream() - returns events with __rawBytes already set
    return bedrockClient.converseStream(request.modelId, commandInput);
  },

  extractErrorMessage(error: unknown): string {
    // Handle AWS SDK error format
    if (error && typeof error === "object") {
      const awsError = error as {
        message?: string;
        $metadata?: { httpStatusCode?: number };
        name?: string;
      };
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
