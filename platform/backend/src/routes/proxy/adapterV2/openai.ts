import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
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
  OpenAi,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { estimateMessagesSize } from "@/utils/message-size";
import {
  estimateToolResultContentLength,
  previewToolResultContent,
} from "@/utils/tool-result-preview";
import { MockOpenAIClient } from "../mock-openai-client";
import {
  doesModelSupportImages,
  hasImageContent,
  isImageTooLarge,
  isMcpImageBlock,
} from "../utils/mcp-image";
import { stripBrowserToolsResults } from "../utils/summarize-tool-results";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiStreamChunk = OpenAi.Types.ChatCompletionChunk;

type OpenAiToolResultImageBlock = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

type OpenAiToolResultTextBlock = {
  type: "text";
  text: string;
};

type OpenAiToolResultContentBlock =
  | OpenAiToolResultImageBlock
  | OpenAiToolResultTextBlock;

type OpenAiToolResultContent = string | OpenAiToolResultContentBlock[];

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

// Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
export class OpenAIRequestAdapter
  implements LLMRequestAdapter<OpenAiRequest, OpenAiMessages>
{
  readonly provider = "openai" as const;
  private request: OpenAiRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: OpenAiRequest) {
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

  getProviderMessages(): OpenAiMessages {
    return this.request.messages;
  }

  getOriginalRequest(): OpenAiRequest {
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

  convertToolResultContent(messages: OpenAiMessages): OpenAiMessages {
    const model = this.getModel();
    const modelSupportsImages = doesModelSupportImages(model);
    let toolMessagesWithImages = 0;
    let strippedImageCount = 0;

    // First, analyze all tool messages to understand what we're dealing with
    for (const message of messages) {
      if (message.role === "tool") {
        const contentLength = estimateToolResultContentLength(message.content);
        const contentSizeKB = Math.round(contentLength.length / 1024);
        const contentPatternSample = previewToolResultContent(
          message.content,
          2000,
        );
        const contentPreview = contentPatternSample.slice(0, 200);

        // Check for base64 patterns in preview to avoid full serialization.
        const hasBase64 =
          contentPatternSample.includes("data:image") ||
          contentPatternSample.includes('"type":"image"') ||
          contentPatternSample.includes('"data":"');

        // Find tool name from previous assistant message
        const toolName = this.findToolNameInMessages(
          messages,
          message.tool_call_id,
        );

        logger.info(
          {
            toolCallId: message.tool_call_id,
            toolName,
            contentSizeKB,
            hasBase64,
            contentLengthEstimated: contentLength.isEstimated,
            isArray: Array.isArray(message.content),
            contentPreview,
          },
          "[OpenAIAdapter] Analyzing tool result content",
        );

        // If it's an array, analyze each item
        if (Array.isArray(message.content)) {
          for (const [idx, item] of message.content.entries()) {
            if (typeof item === "object" && item !== null) {
              const itemType = (item as Record<string, unknown>).type;
              const itemLength = estimateToolResultContentLength(item);
              logger.info(
                {
                  toolCallId: message.tool_call_id,
                  itemIndex: idx,
                  itemType,
                  itemSizeKB: Math.round(itemLength.length / 1024),
                  itemLengthEstimated: itemLength.isEstimated,
                  isMcpImage: isMcpImageBlock(item),
                },
                "[OpenAIAdapter] Tool result array item",
              );
            }
          }
        }
      }
    }

    const result = messages.map((message) => {
      if (message.role !== "tool") {
        return message;
      }

      // Check if this tool message contains images
      if (!hasImageContent(message.content)) {
        return message;
      }

      // If model doesn't support images, strip image blocks from content
      if (!modelSupportsImages) {
        strippedImageCount++;
        const strippedContent = stripImageBlocksFromContent(message.content);
        return {
          ...message,
          content: strippedContent,
        };
      }

      // Model supports images - convert MCP image blocks to OpenAI format
      const convertedContent = convertMcpImageBlocksToOpenAi(message.content);
      if (!convertedContent) {
        return message;
      }

      toolMessagesWithImages++;
      return {
        ...message,
        content: convertedContent,
      };
    });

    if (toolMessagesWithImages > 0 || strippedImageCount > 0) {
      logger.info(
        {
          model,
          modelSupportsImages,
          totalMessages: messages.length,
          toolMessagesWithImages,
          strippedImageCount,
        },
        "[OpenAIAdapter] Processed tool messages with image content",
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): OpenAiRequest {
    let messages = this.request.messages;

    if (Object.keys(this.toolResultUpdates).length > 0) {
      messages = this.applyUpdates(messages, this.toolResultUpdates);
    }

    if (config.features.browserStreamingEnabled) {
      messages = this.convertToolResultContent(messages);
      const sizeBeforeStrip = estimateMessagesSize(messages);
      messages = stripBrowserToolsResults(messages);
      const sizeAfterStrip = estimateMessagesSize(messages);

      if (sizeBeforeStrip.length !== sizeAfterStrip.length) {
        logger.info(
          {
            sizeBeforeKB: Math.round(sizeBeforeStrip.length / 1024),
            sizeAfterKB: Math.round(sizeAfterStrip.length / 1024),
            savedKB: Math.round(
              (sizeBeforeStrip.length - sizeAfterStrip.length) / 1024,
            ),
            sizeEstimateReliable:
              !sizeBeforeStrip.isEstimated && !sizeAfterStrip.isEstimated,
          },
          "[OpenAIAdapter] Stripped browser tool results",
        );
      }
    }

    // Calculate approximate request size for debugging
    const requestSize = estimateMessagesSize(messages);
    const requestSizeKB = Math.round(requestSize.length / 1024);
    const estimatedTokens = Math.round(requestSize.length / 4);
    let imageCount = 0;
    let totalImageBase64Length = 0;

    for (const msg of messages) {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (
            typeof part === "object" &&
            part !== null &&
            "type" in part &&
            part.type === "image_url" &&
            "image_url" in part &&
            part.image_url &&
            typeof part.image_url === "object" &&
            "url" in part.image_url
          ) {
            imageCount++;
            const imageUrl = part.image_url.url;
            if (typeof imageUrl === "string" && imageUrl.startsWith("data:")) {
              const base64Part = imageUrl.split(",")[1];
              if (base64Part) {
                totalImageBase64Length += base64Part.length;
              }
            }
          }
        }
      }
    }

    logger.info(
      {
        model: this.getModel(),
        messageCount: messages.length,
        requestSizeKB,
        estimatedTokens,
        sizeEstimateReliable: !requestSize.isEstimated,
        hasToolResultUpdates: Object.keys(this.toolResultUpdates).length > 0,
        imageCount,
        totalImageBase64KB: Math.round((totalImageBase64Length * 3) / 4 / 1024),
      },
      "[OpenAIAdapter] Building provider request",
    );

    return {
      ...this.request,
      model: this.getModel(),
      messages,
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers (copied from utils/adapters/openai.ts)
  // ---------------------------------------------------------------------------

  private findToolNameInMessages(
    messages: OpenAiMessages,
    toolCallId: string,
  ): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];

      if (message.role === "assistant" && message.tool_calls) {
        for (const toolCall of message.tool_calls) {
          if (toolCall.id === toolCallId) {
            if (toolCall.type === "function") {
              return toolCall.function.name;
            } else {
              return toolCall.custom.name;
            }
          }
        }
      }
    }

    return null;
  }

  private toCommonFormat(messages: OpenAiMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[OpenAIAdapter] toCommonFormat: starting conversion",
    );
    const commonMessages: CommonMessage[] = [];

    for (const message of messages) {
      const commonMessage: CommonMessage = {
        role: message.role as CommonMessage["role"],
      };

      // Handle tool messages (tool results)
      if (message.role === "tool") {
        const toolName = this.findToolNameInMessages(
          messages,
          message.tool_call_id,
        );

        if (toolName) {
          logger.debug(
            { toolCallId: message.tool_call_id, toolName },
            "[OpenAIAdapter] toCommonFormat: found tool message",
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
      "[OpenAIAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  private applyUpdates(
    messages: OpenAiMessages,
    updates: Record<string, string>,
  ): OpenAiMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[OpenAIAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[OpenAIAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      if (message.role === "tool" && updates[message.tool_call_id]) {
        appliedCount++;
        logger.debug(
          { toolCallId: message.tool_call_id },
          "[OpenAIAdapter] applyUpdates: applying update to tool message",
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
      "[OpenAIAdapter] applyUpdates: complete",
    );
    return result;
  }
}

// Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
export function convertMcpImageBlocksToOpenAi(
  content: unknown,
): OpenAiToolResultContent | null {
  if (!Array.isArray(content)) {
    return null;
  }

  if (!hasImageContent(content)) {
    return null;
  }

  const openAiContent: OpenAiToolResultContentBlock[] = [];
  const imageTooLargePlaceholder = "[Image omitted due to size]";

  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (isMcpImageBlock(item)) {
      const mimeType = item.mimeType ?? "image/png";
      const base64Length = typeof item.data === "string" ? item.data.length : 0;
      const estimatedSizeKB = Math.round((base64Length * 3) / 4 / 1024);
      const shouldStripImage = isImageTooLarge(item);

      if (shouldStripImage) {
        logger.info(
          {
            mimeType,
            base64Length,
            estimatedSizeKB,
          },
          "[OpenAIAdapter] Stripping MCP image block due to size limit",
        );
        openAiContent.push({
          type: "text",
          text: imageTooLargePlaceholder,
        });
        continue;
      }

      logger.info(
        {
          mimeType,
          base64Length,
          estimatedSizeKB,
          // Estimate tokens: base64 chars / 4 (rough estimate for text tokens)
          // But for images, OpenAI uses tile-based calculation
          estimatedBase64Tokens: Math.round(base64Length / 4),
        },
        "[OpenAIAdapter] Converting MCP image block to OpenAI format",
      );

      openAiContent.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${item.data}`,
        },
      });
    } else if (candidate.type === "text" && "text" in candidate) {
      openAiContent.push({
        type: "text",
        text:
          typeof candidate.text === "string"
            ? candidate.text
            : JSON.stringify(candidate),
      });
    }
  }

  logger.info(
    {
      totalBlocks: openAiContent.length,
      imageBlocks: openAiContent.filter((b) => b.type === "image_url").length,
      textBlocks: openAiContent.filter((b) => b.type === "text").length,
    },
    "[OpenAIAdapter] Converted MCP content to OpenAI format",
  );

  return openAiContent.length > 0 ? openAiContent : null;
}

/**
 * Strip image blocks from MCP content when model doesn't support images.
 * Keeps text blocks and replaces image blocks with a placeholder message.
 * Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
 */
export function stripImageBlocksFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return typeof content === "string" ? content : JSON.stringify(content);
  }

  const textParts: string[] = [];
  let imageCount = 0;

  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const candidate = item as Record<string, unknown>;

    if (isMcpImageBlock(item)) {
      imageCount++;
    } else if (candidate.type === "text" && "text" in candidate) {
      textParts.push(
        typeof candidate.text === "string"
          ? candidate.text
          : JSON.stringify(candidate.text),
      );
    }
  }

  // Add placeholder for stripped images
  if (imageCount > 0) {
    textParts.push(
      `[${imageCount} image(s) removed - model does not support image inputs]`,
    );
    logger.info(
      { imageCount },
      "[OpenAIAdapter] Stripped images from tool result (model does not support images)",
    );
  }

  return textParts.join("\n");
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

// Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
export class OpenAIResponseAdapter
  implements LLMResponseAdapter<OpenAiResponse>
{
  readonly provider = "openai" as const;
  private response: OpenAiResponse;

  constructor(response: OpenAiResponse) {
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
      } else if (toolCall.type === "custom" && toolCall.custom) {
        name = toolCall.custom.name;
        try {
          args = JSON.parse(toolCall.custom.input);
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

  getOriginalResponse(): OpenAiResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): OpenAiResponse {
    return {
      ...this.response,
      choices: [
        {
          ...this.response.choices[0],
          message: {
            role: "assistant",
            content: contentMessage,
            refusal: null,
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

// Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
export class OpenAIStreamAdapter
  implements LLMStreamAdapter<OpenAiStreamChunk, OpenAiResponse>
{
  readonly provider = "openai" as const;
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

  processChunk(chunk: OpenAiStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    this.state.responseId = chunk.id;
    this.state.model = chunk.model;

    // Handle usage first - OpenAI sends usage in a final chunk with empty choices[]
    // when stream_options.include_usage is true
    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      // If we have usage, this is the final chunk (OpenAI sends usage in a chunk with empty choices)
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: this.state.usage !== null,
      };
    }

    const delta = choice.delta;

    // Handle text content
    if (delta.content) {
      this.state.text += delta.content;
      sseData = `data: ${JSON.stringify(chunk)}\n\n`;
    }

    // Handle tool calls
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

    // Handle finish reason
    // Note: Don't set isFinal here - OpenAI sends the usage chunk AFTER the finish_reason chunk
    // when stream_options.include_usage is true (which we always set in executeStream)
    if (choice.finish_reason) {
      this.state.stopReason = choice.finish_reason;
    }

    // Only mark as final after we've received usage data (which comes in a separate chunk
    // after the finish_reason chunk when include_usage is enabled)
    if (this.state.usage !== null) {
      isFinal = true;
    }

    return { sseData, isToolCallChunk, isFinal };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    const chunk: OpenAiStreamChunk = {
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
    const chunk: OpenAiStreamChunk = {
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
    const finalChunk: OpenAiStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason:
            (this.state.stopReason as "stop" | "tool_calls") ?? "stop",
        },
      ],
    };
    return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
  }

  toProviderResponse(): OpenAiResponse {
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
            refusal: null,
            tool_calls: toolCalls,
          },
          logprobs: null,
          finish_reason:
            (this.state.stopReason as OpenAi.Types.FinishReason) ?? "stop",
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
// TOON COMPRESSION (copied from utils/adapters/openai.ts)
// =============================================================================

// Exported for reuse by OpenAI-compatible providers (Mistral, etc.)
export async function convertToolResultsToToon(
  messages: OpenAiMessages,
  model: string,
): Promise<{
  messages: OpenAiMessages;
  stats: ToolCompressionStats;
}> {
  const tokenizer = getTokenizer("openai");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
      logger.info(
        {
          toolCallId: message.tool_call_id,
          contentType: typeof message.content,
          provider: "openai",
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

          // Always count tokens
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
                provider: "openai",
              },
              "convertToolResultsToToon: compressed",
            );
            logger.debug(
              {
                toolCallId: message.tool_call_id,
                before: noncompressed,
                after: compressed,
                provider: "openai",
                supposedToBeJson: parsed,
              },
              "convertToolResultsToToon: before/after",
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
              provider: "openai",
            },
            "Skipping TOON compression - compressed output has more tokens",
          );
          return message;
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

  // Calculate cost savings (always a number, 0 if no savings)
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
// ADAPTER FACTORY
// =============================================================================

// =============================================================================
// USAGE TOKEN HELPERS
// =============================================================================

export function getUsageTokens(usage: OpenAi.Types.Usage) {
  return {
    input: usage.prompt_tokens,
    output: usage.completion_tokens,
  };
}

export const openaiAdapterFactory: LLMProvider<
  OpenAiRequest,
  OpenAiResponse,
  OpenAiMessages,
  OpenAiStreamChunk,
  OpenAiHeaders
> = {
  provider: "openai",
  interactionType: "openai:chatCompletions",

  createRequestAdapter(
    request: OpenAiRequest,
  ): LLMRequestAdapter<OpenAiRequest, OpenAiMessages> {
    return new OpenAIRequestAdapter(request);
  },

  createResponseAdapter(
    response: OpenAiResponse,
  ): LLMResponseAdapter<OpenAiResponse> {
    return new OpenAIResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<OpenAiStreamChunk, OpenAiResponse> {
    return new OpenAIStreamAdapter();
  },

  extractApiKey(headers: OpenAiHeaders): string | undefined {
    // Return the authorization header as-is (legacy behavior)
    // OpenAI SDK handles both "Bearer sk-xxx" and "sk-xxx" formats
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.openai.baseUrl;
  },

  getSpanName(): string {
    return "openai.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    // Use observable fetch for request duration metrics if agent is provided
    const customFetch = options?.agent
      ? metrics.llm.getObservableFetch(
          "openai",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    return new OpenAIProvider({
      apiKey,
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: OpenAiRequest,
  ): Promise<OpenAiResponse> {
    const openaiClient = client as OpenAIProvider;
    const openaiRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return openaiClient.chat.completions.create(
      openaiRequest,
    ) as Promise<OpenAiResponse>;
  },

  async executeStream(
    client: unknown,
    request: OpenAiRequest,
  ): Promise<AsyncIterable<OpenAiStreamChunk>> {
    const openaiClient = client as OpenAIProvider;
    const openaiRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await openaiClient.chat.completions.create(openaiRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as OpenAiStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // OpenAI SDK error structure
    const openaiMessage = get(error, "error.message");
    if (typeof openaiMessage === "string") {
      return openaiMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
