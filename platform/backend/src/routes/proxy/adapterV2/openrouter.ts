/**
 * OpenRouter LLM Proxy Adapter - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * This adapter reuses OpenAI's logic with OpenRouter-specific configuration.
 *
 * @see https://openrouter.ai/docs
 */
import { encode as toonEncode } from "@toon-format/toon";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import { getObservableFetch } from "@/llm-metrics";
import { TokenPriceModel } from "@/models";
import { getTokenizer } from "@/tokenizers";
import type {
  ChunkProcessingResult,
  CommonMcpToolDefinition,
  CommonMessage,
  CommonToolCall,
  CommonToolResult,
  LLMProvider,
  LLMRequestAdapter,
  LLMResponseAdapter,
  LLMStreamAdapter,
  OpenRouter,
  StreamAccumulatorState,
  ToolCompressionStats,
  UsageView,
} from "@/types";
import {
  doesModelSupportImages,
  hasImageContent,
} from "../utils/mcp-image";
import { unwrapToolContent } from "../utils/unwrap-tool-content";
import {
  convertMcpImageBlocksToOpenAi,
  stripImageBlocksFromContent,
} from "./openai";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type OpenRouterRequest = OpenRouter.Types.ChatCompletionsRequest;
type OpenRouterResponse = OpenRouter.Types.ChatCompletionsResponse;
type OpenRouterMessages = OpenRouter.Types.ChatCompletionsRequest["messages"];
type OpenRouterHeaders = OpenRouter.Types.ChatCompletionsHeaders;
type OpenRouterStreamChunk = OpenRouter.Types.ChatCompletionChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class OpenRouterRequestAdapter
  implements LLMRequestAdapter<OpenRouterRequest, OpenRouterMessages>
{
  readonly provider = "openrouter" as const;
  private request: OpenRouterRequest;
  private modifiedModel: string | null = null;
  private toolResultUpdates: Record<string, string> = {};

  constructor(request: OpenRouterRequest) {
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

  getProviderMessages(): OpenRouterMessages {
    return this.request.messages;
  }

  getOriginalRequest(): OpenRouterRequest {
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
    return {
      wasEffective: stats.toonTokensBefore !== null && stats.toonTokensAfter !== null,
      hadToolResults: stats.toonTokensBefore !== null,
      tokensBefore: stats.toonTokensBefore ?? 0,
      tokensAfter: stats.toonTokensAfter ?? 0,
      costSavings: stats.toonCostSavings ?? 0,
    };
  }

  convertToolResultContent(messages: OpenRouterMessages): OpenRouterMessages {
    const model = this.getModel();
    const modelSupportsImages = doesModelSupportImages(model);

    // Reuse OpenAI logic for content conversion since API is compatible
    return messages.map((message) => {
      if (message.role !== "tool") return message;

      if (!hasImageContent(message.content)) return message;

      if (!modelSupportsImages) {
        return {
          ...message,
          content: stripImageBlocksFromContent(message.content),
        };
      }

      // Types are compatible enough for this helper (OpenRouter ~ OpenAI)
      const converted = convertMcpImageBlocksToOpenAi(message.content);
      return converted
        ? { ...message, content: converted as unknown }
        : message;
    }) as OpenRouterMessages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): OpenRouterRequest {
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
    messages: OpenRouterMessages,
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
              // @ts-ignore
              return toolCall.custom?.name;
            }
          }
        }
      }
    }

    return null;
  }

  private toCommonFormat(messages: OpenRouterMessages): CommonMessage[] {
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
    messages: OpenRouterMessages,
    updates: Record<string, string>,
  ): OpenRouterMessages {
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

    return result as OpenRouterMessages;
  }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class OpenRouterResponseAdapter
  implements LLMResponseAdapter<OpenRouterResponse>
{
  readonly provider = "openrouter" as const;
  private response: OpenRouterResponse;

  constructor(response: OpenRouterResponse) {
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

  getOriginalResponse(): OpenRouterResponse {
    return this.response;
  }

  toRefusalResponse(
    _refusalMessage: string,
    contentMessage: string,
  ): OpenRouterResponse {
    return {
      ...this.response,
      choices: [
        {
          ...this.response.choices[0],
          message: {
            role: "assistant",
            content: contentMessage,
            tool_calls: undefined,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
    };
  }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class OpenRouterStreamAdapter
  implements LLMStreamAdapter<OpenRouterStreamChunk, OpenRouterResponse>
{
  readonly provider = "openrouter" as const;
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

  processChunk(chunk: OpenRouterStreamChunk): ChunkProcessingResult {
    if (this.state.timing.firstChunkTime === null) {
      this.state.timing.firstChunkTime = Date.now();
    }

    let sseData: string | null = null;
    let isToolCallChunk = false;
    let isFinal = false;

    this.state.responseId = chunk.id;
    this.state.model = chunk.model;

    // Handle usage first (OpenAI sends it in final chunk usually)
    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      // Could be final usage chunk
      if (chunk.usage) {
        return {
          sseData: null,
          isToolCallChunk: false,
          isFinal: true,
        };
      }
      return {
        sseData: null,
        isToolCallChunk: false,
        isFinal: false,
      };
    }

    const delta = choice.delta;

    // Handle text content or role-only chunks
    if (delta.content !== undefined || delta.role) {
      if (delta.content) {
        this.state.text += delta.content;
      }
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
      isFinal = true;

      // Send final chunk with finish reason
      if (!sseData) {
        sseData = `data: ${JSON.stringify(chunk)}\n\n`;
      }
    }

    return {
      sseData,
      isToolCallChunk,
      isFinal,
    };
  }

  getSSEHeaders(): Record<string, string> {
    return {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
  }

  formatTextDeltaSSE(text: string): string {
    const chunk: OpenRouterStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Date.now() / 1000,
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }

  formatCompleteTextSSE(text: string): string[] {
    const chunk: OpenRouterStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Date.now() / 1000,
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    };

    const stopChunk: OpenRouterStreamChunk = {
      id: this.state.responseId,
      object: "chat.completion.chunk",
      created: Date.now() / 1000,
      model: this.state.model,
      choices: [
        {
          index: 0,
          delta: {},
          finish_reason: "stop",
        },
      ],
    };

    return [
      `data: ${JSON.stringify(chunk)}\n\n`,
      `data: ${JSON.stringify(stopChunk)}\n\n`,
    ];
  }

  formatEndSSE(): string {
    return "data: [DONE]\n\n";
  }

  getRawToolCallEvents(): string[] {
    return this.state.rawToolCallEvents.map(
      (chunk) => `data: ${JSON.stringify(chunk)}\n\n`,
    );
  }

  toProviderResponse(): OpenRouterResponse {
    return {
      id: this.state.responseId,
      object: "chat.completion",
      created: Date.now() / 1000,
      model: this.state.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: this.state.text || null,
            tool_calls:
              this.state.toolCalls.length > 0
                ? this.state.toolCalls.map((tc) => ({
                    id: tc.id,
                    type: "function",
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  }))
                : undefined,
          },
          finish_reason:
            (this.state.stopReason as OpenRouter.Types.FinishReason) ?? "stop",
          logprobs: null,
        },
      ],
      usage: this.state.usage
        ? {
            prompt_tokens: this.state.usage.inputTokens,
            completion_tokens: this.state.usage.outputTokens,
            total_tokens:
              this.state.usage.inputTokens + this.state.usage.outputTokens,
          }
        : undefined,
    };
  }
}

// =============================================================================
// PROVIDER IMPLEMENTATION
// =============================================================================

export const openrouterAdapterFactory: LLMProvider<
  OpenRouterRequest,
  OpenRouterResponse,
  OpenRouterMessages,
  OpenRouterStreamChunk,
  OpenRouterHeaders
> = {
  provider: "openrouter",
  interactionType: "openrouter:chatCompletions", // Arbitrary unique string, follows convention

  createClient: (apiKey, options) => {
    // OpenRouter requires these headers for ranking/visibility
    const defaultHeaders = {
      "HTTP-Referer": config.frontendBaseUrl,
      "X-Title": "Archestra",
      ...options?.defaultHeaders,
    };

    return new OpenAIProvider({
      apiKey: apiKey || "dummy-key",
      baseURL: options?.baseUrl || "https://openrouter.ai/api/v1",
      defaultHeaders,
      fetch:
        options?.agent
          ? getObservableFetch(
              "openrouter",
              options.agent,
              options.externalAgentId,
            )
          : undefined,
    });
  },

  createRequestAdapter: (request) => new OpenRouterRequestAdapter(request),

  createResponseAdapter: (response) => new OpenRouterResponseAdapter(response),

  createStreamAdapter: () => new OpenRouterStreamAdapter(),

  extractApiKey: (headers) => {
    return (headers as Record<string, string>)["authorization"]?.replace(
      "Bearer ",
      "",
    );
  },

  extractErrorMessage: (error) => {
    const err = error as any;
    // OpenRouter specific error structure might vary, but follows OpenAI mostly
    return (
      err.response?.data?.error?.message ||
      err.message ||
      "Unknown OpenRouter error"
    );
  },

  execute: async (client, request) => {
    const openai = client as OpenAIProvider;
    return (await openai.chat.completions.create(
      request as ChatCompletionCreateParamsNonStreaming,
    )) as unknown as OpenRouterResponse;
  },

  executeStream: async (client, request) => {
    const openai = client as OpenAIProvider;
    // OpenRouter supports stream_usage=true if needed, but OpenAI SDK handles stream_options
    // We assume the request already has stream_options if the user/client set it.
    return (await openai.chat.completions.create({
      ...(request as ChatCompletionCreateParamsStreaming),
      stream: true,
    })) as unknown as AsyncIterable<OpenRouterStreamChunk>;
  },

  getSpanName: (isStreaming) => {
    return `openrouter.chat.completions${isStreaming ? ".stream" : ""}`;
  },

  getBaseUrl: () => {
    return config.llm.openrouter.baseUrl || "https://openrouter.ai/api/v1";
  },
};

// =============================================================================
// HELPER FUNCTIONS FROM OPENAI
// =============================================================================

type CompressionStats = {
  toonTokensBefore: number | null;
  toonTokensAfter: number | null;
  toonCostSavings: number | null;
}

// Logic to compress tool results into TOON format if enabled/requested
async function convertToolResultsToToon(
  messages: OpenRouterMessages,
  model: string,
): Promise<{
  messages: OpenRouterMessages;
  stats: CompressionStats;
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

          totalTokensBefore += tokensBefore;
          totalTokensAfter += tokensAfter;
          toolResultCount++;

          return {
            ...message,
            content: compressed,
          };
        } catch {
          return message;
        }
      }
    }
    return message;
  });

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
    messages: result as OpenRouterMessages,
    stats: {
      toonTokensBefore: toolResultCount > 0 ? totalTokensBefore : null,
      toonTokensAfter: toolResultCount > 0 ? totalTokensAfter : null,
      toonCostSavings,
    },
  };
}
