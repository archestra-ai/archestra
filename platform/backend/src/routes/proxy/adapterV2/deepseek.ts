/**
 * DeepSeek Adapter
 *
 * DeepSeek exposes an OpenAI-compatible API.
 * See: https://api-docs.deepseek.com/
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
  DeepSeek,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
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

type DeepSeekRequest = DeepSeek.Types.ChatCompletionsRequest;
type DeepSeekResponse = DeepSeek.Types.ChatCompletionsResponse;
type DeepSeekMessages = DeepSeek.Types.ChatCompletionsRequest["messages"];
type DeepSeekHeaders = DeepSeek.Types.ChatCompletionsHeaders;
type DeepSeekStreamChunk = DeepSeek.Types.ChatCompletionChunk;

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

  async applyToonCompression(model: string): Promise<ToolCompressionStats> {
    const { messages: compressedMessages, stats } =
      await convertToolResultsToToon(this.request.messages, model);
    this.request = {
      ...this.request,
      messages: compressedMessages,
    };
    return stats;
  }

  convertToolResultContent(messages: DeepSeekMessages): DeepSeekMessages {
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
          "[DeepSeekAdapter] Analyzing tool result content",
        );
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

      return message;
    });

    return result;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): DeepSeekRequest {
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
          "[DeepSeekAdapter] Stripped browser tool results",
        );
      }
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
            } else {
              return toolCall.custom.name;
            }
          }
        }
      }
    }

    return null;
  }

  private toCommonFormat(messages: DeepSeekMessages): CommonMessage[] {
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

  private applyUpdates(
    messages: DeepSeekMessages,
    updates: Record<string, string>,
  ): DeepSeekMessages {
    const updateCount = Object.keys(updates).length;

    if (updateCount === 0) {
      return messages;
    }

    const result = messages.map((message) => {
      if (message.role === "tool" && updates[message.tool_call_id]) {
        return {
          ...message,
          content: updates[message.tool_call_id],
        };
      }
      return message;
    });

    return result;
  }
}

/**
 * Strip image blocks from MCP content when model doesn't support images.
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

  if (imageCount > 0) {
    textParts.push(
      `[${imageCount} image(s) removed - model does not support image inputs]`,
    );
  }

  return textParts.join("\n");
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
    return {
      inputTokens: this.response.usage?.prompt_tokens ?? 0,
      outputTokens: this.response.usage?.completion_tokens ?? 0,
    };
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

    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: this.state.usage !== null,
      };
    }

    const delta = choice.delta;

    if (delta.content) {
      this.state.text += delta.content;
    }

    // DeepSeek might send reasoning_content (for deepseek-reasoner)
    // We forward the chunk if it has content, reasoning_content, or tool_calls
    const hasContent =
      delta.content ||
      (delta as any).reasoning_content ||
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
    }

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
          finish_reason:
            (this.state.stopReason as "stop" | "tool_calls") ?? "stop",
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
            refusal: null,
            tool_calls: toolCalls,
          },
          logprobs: null,
          finish_reason:
            (this.state.stopReason as DeepSeek.Types.FinishReason) ?? "stop",
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
  const tokenizer = getTokenizer("openai");
  let toolResultCount = 0;
  let totalTokensBefore = 0;
  let totalTokensAfter = 0;

  const result = messages.map((message) => {
    if (message.role === "tool") {
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
          totalTokensBefore += tokensBefore;

          if (tokensAfter < tokensBefore) {
            totalTokensAfter += tokensAfter;
            return {
              ...message,
              content: compressed,
            };
          }

          totalTokensAfter += tokensBefore;
          return message;
        } catch {
          return message;
        }
      }
    }

    return message;
  });

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

export const deepseekAdapterFactory: LLMProvider<
  DeepSeekRequest,
  DeepSeekResponse,
  DeepSeekMessages,
  DeepSeekStreamChunk,
  DeepSeekHeaders
> = {
  provider: "deepseek",
  interactionType: "openai:chatCompletions",

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
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? getObservableFetch("deepseek", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey: apiKey || "EMPTY",
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<DeepSeekResponse> {
    const deepseekClient = client as OpenAIProvider;
    const deepseekRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return deepseekClient.chat.completions.create(
      deepseekRequest,
    ) as Promise<DeepSeekResponse>;
  },

  async executeStream(
    client: unknown,
    request: DeepSeekRequest,
  ): Promise<AsyncIterable<DeepSeekStreamChunk>> {
    const deepseekClient = client as OpenAIProvider;
    const deepseekRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await deepseekClient.chat.completions.create(deepseekRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as DeepSeekStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
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
