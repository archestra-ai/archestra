/**
 * Groq Adapter
 *
 * Groq exposes an OpenAI-compatible API.
 * See: https://console.groq.com/docs/api-reference
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
  Groq,
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

type GroqRequest = Groq.Types.ChatCompletionsRequest;
type GroqResponse = Groq.Types.ChatCompletionsResponse;
type GroqMessages = Groq.Types.ChatCompletionsRequest["messages"];
type GroqHeaders = Groq.Types.ChatCompletionsHeaders;
type GroqStreamChunk = Groq.Types.ChatCompletionChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class GroqRequestAdapter
  implements LLMRequestAdapter<GroqRequest, GroqMessages>
{
  readonly provider = "groq" as const;
  private request: GroqRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: GroqRequest) {
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

  getProviderMessages(): GroqMessages {
    return this.request.messages;
  }

  getOriginalRequest(): GroqRequest {
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

  convertToolResultContent(messages: GroqMessages): GroqMessages {
    const model = this.getModel();
    const modelSupportsImages = doesModelSupportImages(model);
    let strippedImageCount = 0;

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

  toProviderRequest(): GroqRequest {
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
          "[GroqAdapter] Stripped browser tool results",
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
    messages: GroqMessages,
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

  private toCommonFormat(messages: GroqMessages): CommonMessage[] {
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
    messages: GroqMessages,
    updates: Record<string, string>,
  ): GroqMessages {
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

class GroqResponseAdapter implements LLMResponseAdapter<GroqResponse> {
  readonly provider = "groq" as const;
  private response: GroqResponse;

  constructor(response: GroqResponse) {
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

  getOriginalResponse(): GroqResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): GroqResponse {
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

class GroqStreamAdapter
  implements LLMStreamAdapter<GroqStreamChunk, GroqResponse>
{
  readonly provider = "groq" as const;
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

  processChunk(chunk: GroqStreamChunk): ChunkProcessingResult {
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
    const chunk: GroqStreamChunk = {
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
    const chunk: GroqStreamChunk = {
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
    const finalChunk: GroqStreamChunk = {
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

  toProviderResponse(): GroqResponse {
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
            (this.state.stopReason as Groq.Types.FinishReason) ?? "stop",
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
  messages: GroqMessages,
  model: string,
): Promise<{
  messages: GroqMessages;
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

export const groqAdapterFactory: LLMProvider<
  GroqRequest,
  GroqResponse,
  GroqMessages,
  GroqStreamChunk,
  GroqHeaders
> = {
  provider: "groq",
  interactionType: "openai:chatCompletions",

  createRequestAdapter(
    request: GroqRequest,
  ): LLMRequestAdapter<GroqRequest, GroqMessages> {
    return new GroqRequestAdapter(request);
  },

  createResponseAdapter(
    response: GroqResponse,
  ): LLMResponseAdapter<GroqResponse> {
    return new GroqResponseAdapter(response);
  },

  createStreamAdapter(): LLMStreamAdapter<GroqStreamChunk, GroqResponse> {
    return new GroqStreamAdapter();
  },

  extractApiKey(headers: GroqHeaders): string | undefined {
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.groq.baseUrl;
  },

  getSpanName(): string {
    return "groq.chat.completions";
  },

  createClient(
    apiKey: string | undefined,
    options?: CreateClientOptions,
  ): OpenAIProvider {
    if (options?.mockMode) {
      return new MockOpenAIClient() as unknown as OpenAIProvider;
    }

    const customFetch = options?.agent
      ? getObservableFetch("groq", options.agent, options.externalAgentId)
      : undefined;

    return new OpenAIProvider({
      apiKey: apiKey || "EMPTY",
      baseURL: options?.baseUrl,
      fetch: customFetch,
    });
  },

  async execute(client: unknown, request: GroqRequest): Promise<GroqResponse> {
    const groqClient = client as OpenAIProvider;
    const groqRequest = {
      ...request,
      stream: false,
    } as unknown as ChatCompletionCreateParamsNonStreaming;
    return groqClient.chat.completions.create(
      groqRequest,
    ) as Promise<GroqResponse>;
  },

  async executeStream(
    client: unknown,
    request: GroqRequest,
  ): Promise<AsyncIterable<GroqStreamChunk>> {
    const groqClient = client as OpenAIProvider;
    const groqRequest = {
      ...request,
      stream: true,
      stream_options: { include_usage: true },
    } as unknown as ChatCompletionCreateParamsStreaming;
    const stream = await groqClient.chat.completions.create(groqRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as GroqStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    const groqMessage = get(error, "error.message");
    if (typeof groqMessage === "string") {
      return groqMessage;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return "Internal server error";
  },
};
