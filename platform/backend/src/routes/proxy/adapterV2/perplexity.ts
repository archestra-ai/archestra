/**
 * Perplexity Adapter
 *
 * Perplexity exposes an OpenAI-compatible API, so this adapter is largely based on the OpenAI adapter.
 * See: https://docs.perplexity.ai/api-reference/chat-completions-post
 */
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import logger from "@/logging";
import { TokenPriceModel } from "@/models";
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
  Perplexity,
  StreamAccumulatorState,
  ToonCompressionResult,
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
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type PerplexityRequest = Perplexity.Types.ChatCompletionsRequest;
type PerplexityResponse = Perplexity.Types.ChatCompletionsResponse;
type PerplexityMessages = Perplexity.Types.ChatCompletionsRequest["messages"];
type PerplexityHeaders = Perplexity.Types.ChatCompletionsHeaders;
type PerplexityStreamChunk = Perplexity.Types.ChatCompletionChunk;

type PerplexityToolResultImageBlock = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

type PerplexityToolResultTextBlock = {
  type: "text";
  text: string;
};

type PerplexityToolResultContentBlock =
  | PerplexityToolResultImageBlock
  | PerplexityToolResultTextBlock;

type PerplexityToolResultContent = string | PerplexityToolResultContentBlock[];

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class PerplexityRequestAdapter
  implements LLMRequestAdapter<PerplexityRequest, PerplexityMessages>
{
  readonly provider = "perplexity" as const;
  private request: PerplexityRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: PerplexityRequest) {
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

  getProviderMessages(): PerplexityMessages {
    return this.request.messages;
  }

  getOriginalRequest(): PerplexityRequest {
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

  convertToolResultContent(messages: PerplexityMessages): PerplexityMessages {
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
          "[PerplexityAdapter] Analyzing tool result content",
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
                "[PerplexityAdapter] Tool result array item",
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

      // Model supports images - convert MCP image blocks to Perplexity/OpenAI format
      const convertedContent = convertMcpImageBlocksToPerplexity(
        message.content,
      );
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
        "[PerplexityAdapter] Processed tool messages with image content",
      );
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): PerplexityRequest {
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
          "[PerplexityAdapter] Stripped browser tool results",
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
      "[PerplexityAdapter] Building provider request",
    );

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
    messages: PerplexityMessages,
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

  private toCommonFormat(messages: PerplexityMessages): CommonMessage[] {
    logger.debug(
      { messageCount: messages.length },
      "[PerplexityAdapter] toCommonFormat: starting conversion",
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
            "[PerplexityAdapter] toCommonFormat: found tool message",
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
      "[PerplexityAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }

  private applyUpdates(
    messages: PerplexityMessages,
    updates: Record<string, string>,
  ): PerplexityMessages {
    const updateCount = Object.keys(updates).length;
    logger.debug(
      { messageCount: messages.length, updateCount },
      "[PerplexityAdapter] applyUpdates: starting",
    );

    if (updateCount === 0) {
      logger.debug("[PerplexityAdapter] applyUpdates: no updates to apply");
      return messages;
    }

    let appliedCount = 0;
    const result = messages.map((message) => {
      if (message.role === "tool" && updates[message.tool_call_id]) {
        appliedCount++;
        logger.debug(
          { toolCallId: message.tool_call_id },
          "[PerplexityAdapter] applyUpdates: applying update to tool message",
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
      "[PerplexityAdapter] applyUpdates: complete",
    );
    return result;
  }
}

function convertMcpImageBlocksToPerplexity(
  content: unknown,
): PerplexityToolResultContent | null {
  if (!Array.isArray(content)) {
    return null;
  }

  if (!hasImageContent(content)) {
    return null;
  }

  const perplexityContent: PerplexityToolResultContentBlock[] = [];
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
          "[PerplexityAdapter] Stripping MCP image block due to size limit",
        );
        perplexityContent.push({
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
          estimatedBase64Tokens: Math.round(base64Length / 4),
        },
        "[PerplexityAdapter] Converting MCP image block to Perplexity format",
      );

      perplexityContent.push({
        type: "image_url",
        image_url: {
          url: `data:${mimeType};base64,${item.data}`,
        },
      });
    } else if (candidate.type === "text" && "text" in candidate) {
      perplexityContent.push({
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
      totalBlocks: perplexityContent.length,
      imageBlocks: perplexityContent.filter((b) => b.type === "image_url")
        .length,
      textBlocks: perplexityContent.filter((b) => b.type === "text").length,
    },
    "[PerplexityAdapter] Converted MCP content to Perplexity format",
  );

  return perplexityContent.length > 0 ? perplexityContent : null;
}

/**
 * Strip image blocks from MCP content when model doesn't support images.
 * Keeps text blocks and replaces image blocks with a placeholder message.
 */
function stripImageBlocksFromContent(content: unknown): string {
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
      "[PerplexityAdapter] Stripped images from tool result (model does not support images)",
    );
  }

  return textParts.join("\n");
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class PerplexityResponseAdapter
  implements LLMResponseAdapter<PerplexityResponse>
{
  readonly provider = "perplexity" as const;
  private response: PerplexityResponse;

  constructor(response: PerplexityResponse) {
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
      const name = toolCall.function.name;
      let args: Record<string, unknown>;

      try {
        args = JSON.parse(toolCall.function.arguments);
      } catch {
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
    return {
      inputTokens: this.response.usage?.prompt_tokens ?? 0,
      outputTokens: this.response.usage?.completion_tokens ?? 0,
    };
  }

  getOriginalResponse(): PerplexityResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): PerplexityResponse {
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

class PerplexityStreamAdapter
  implements LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse>
{
  readonly provider = "perplexity" as const;
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

  processChunk(chunk: PerplexityStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    this.state.responseId = chunk.id;
    this.state.model = chunk.model;

    // Handle usage first - Perplexity (like OpenAI) sends usage in a final chunk with empty choices[]
    // when stream_options.include_usage is true
    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      // If we have usage, this is the final chunk
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
    if (choice.finish_reason) {
      this.state.stopReason = choice.finish_reason;
    }

    // Only mark as final after we've received usage data
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
    const chunk: PerplexityStreamChunk = {
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
    const chunk: PerplexityStreamChunk = {
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
    const finalChunk: PerplexityStreamChunk = {
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

  toProviderResponse(): PerplexityResponse {
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
            (this.state.stopReason as Perplexity.Types.FinishReason) ?? "stop",
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
  messages: PerplexityMessages,
  model: string,
): Promise<{
  messages: PerplexityMessages;
  stats: CompressionStats;
}> {
  // Use OpenAI tokenizer since Perplexity uses similar tokenization
  const tokenizer = getTokenizer("perplexity");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
      logger.info(
        {
          toolCallId: message.tool_call_id,
          contentType: typeof message.content,
          provider: "perplexity",
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
              beforeLength: noncompressed.length,
              afterLength: compressed.length,
              tokensBefore,
              tokensAfter,
              toonPreview: compressed.substring(0, 150),
              provider: "perplexity",
            },
            "convertToolResultsToToon: compressed",
          );
          logger.debug(
            {
              toolCallId: message.tool_call_id,
              before: noncompressed,
              after: compressed,
              provider: "perplexity",
              supposedToBeJson: parsed,
            },
            "convertToolResultsToToon: before/after",
          );

          return {
            ...message,
            content: compressed,
          };
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

export const perplexityAdapterFactory: LLMProvider<
  PerplexityRequest,
  PerplexityResponse,
  PerplexityMessages,
  PerplexityStreamChunk,
  PerplexityHeaders
> = {
  provider: "perplexity",
  interactionType: "perplexity:chatCompletions",

  createRequestAdapter(
    request: PerplexityRequest,
  ): LLMRequestAdapter<PerplexityRequest, PerplexityMessages> {
    return new PerplexityRequestAdapter(request);
  },

  createResponseAdapter(
    response: PerplexityResponse,
  ): LLMResponseAdapter<PerplexityResponse> {
    return new PerplexityResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<
    PerplexityStreamChunk,
    PerplexityResponse
  > {
    return new PerplexityStreamAdapter();
  },

  extractApiKey(headers: PerplexityHeaders): string | undefined {
    return headers.authorization ?? undefined;
  },

  getBaseUrl(): string | undefined {
    return config.llm.perplexity.baseUrl;
  },

  getSpanName(): string {
    return "perplexity.chat.completions";
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
      ? getObservableFetch("perplexity", options.agent, options.externalAgentId)
      : undefined;

    // Perplexity uses OpenAI SDK since it's OpenAI-compatible
    return new OpenAIProvider({
      apiKey: apiKey || "",
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: PerplexityRequest,
  ): Promise<PerplexityResponse> {
    const perplexityClient = client as OpenAIProvider;
    const perplexityRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return perplexityClient.chat.completions.create(
      perplexityRequest,
    ) as Promise<PerplexityResponse>;
  },

  async executeStream(
    client: unknown,
    request: PerplexityRequest,
  ): Promise<AsyncIterable<PerplexityStreamChunk>> {
    const perplexityClient = client as OpenAIProvider;
    const perplexityRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await perplexityClient.chat.completions.create(
      perplexityRequest,
    );

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as PerplexityStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // Perplexity uses OpenAI SDK error structure
    const perplexityMessage = get(error, "error.message");
    if (typeof perplexityMessage === "string") {
      return perplexityMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
