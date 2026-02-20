/**
 * Perplexity LLM Proxy Adapter - OpenAI-compatible
 *
 * Perplexity uses an OpenAI-compatible API at https://api.perplexity.ai
 *
 * Key differences from OpenAI:
 * - No external tool calling support (returns empty for tool methods)
 * - Returns search_results and citations from internal web search
 * - Has Perplexity-specific usage metrics
 *
 * @see https://docs.perplexity.ai/api-reference/chat-completions-post
 */
import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import config from "@/config";
import logger from "@/logging";
import { metrics } from "@/observability";
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
  ToolCompressionStats,
  UsageView,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type PerplexityRequest = Perplexity.Types.ChatCompletionsRequest;
type PerplexityResponse = Perplexity.Types.ChatCompletionsResponse;
type PerplexityMessages = Perplexity.Types.ChatCompletionsRequest["messages"];
type PerplexityHeaders = Perplexity.Types.ChatCompletionsHeaders;
type PerplexityStreamChunk = Perplexity.Types.ChatCompletionChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class PerplexityRequestAdapter
  implements LLMRequestAdapter<PerplexityRequest, PerplexityMessages>
{
  readonly provider = "perplexity" as const;
  private request: PerplexityRequest;
  private modifiedModel: string | null = null;

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

  // Perplexity doesn't support tool calling - return empty
  getToolResults(): CommonToolResult[] {
    return [];
  }

  // Perplexity doesn't support tool calling - return empty
  getTools(): CommonMcpToolDefinition[] {
    return [];
  }

  // Perplexity doesn't support tool calling
  hasTools(): boolean {
    return false;
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

  // Perplexity doesn't support tool calling - no-op
  updateToolResult(_toolCallId: string, _newContent: string): void {
    // No-op: Perplexity doesn't support tool calling
  }

  // Perplexity doesn't support tool calling - no-op
  applyToolResultUpdates(_updates: Record<string, string>): void {
    // No-op: Perplexity doesn't support tool calling
  }

  // Perplexity doesn't support tool calling - return stats with no compression
  async applyToonCompression(_model: string): Promise<ToolCompressionStats> {
    return {
      tokensBefore: 0,
      tokensAfter: 0,
      costSavings: 0,
      wasEffective: false,
      hadToolResults: false,
    };
  }

  // Perplexity doesn't support tool calling - return messages unchanged
  convertToolResultContent(messages: PerplexityMessages): PerplexityMessages {
    return messages;
  }

  // ---------------------------------------------------------------------------
  // Build Modified Request
  // ---------------------------------------------------------------------------

  toProviderRequest(): PerplexityRequest {
    return {
      ...this.request,
      model: this.getModel(),
    };
  }

  // ---------------------------------------------------------------------------
  // Private Helpers
  // ---------------------------------------------------------------------------

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
      commonMessages.push(commonMessage);
    }

    logger.debug(
      { inputCount: messages.length, outputCount: commonMessages.length },
      "[PerplexityAdapter] toCommonFormat: conversion complete",
    );
    return commonMessages;
  }
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

  // Perplexity doesn't support tool calling
  getToolCalls(): CommonToolCall[] {
    return [];
  }

  // Perplexity doesn't support tool calling
  hasToolCalls(): boolean {
    return false;
  }

  getUsage(): UsageView {
    return {
      inputTokens: this.response.usage?.prompt_tokens ?? 0,
      outputTokens: this.response.usage?.completion_tokens ?? 0,
    };
  }

  getFinishReasons(): string[] {
    const reason = this.response.choices[0]?.finish_reason;
    return reason ? [reason] : [];
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

class PerplexityStreamAdapter
  implements LLMStreamAdapter<PerplexityStreamChunk, PerplexityResponse>
{
  readonly provider = "perplexity" as const;
  readonly state: StreamAccumulatorState;

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
    const isToolCallChunk = false; // Perplexity doesn't support tools
    let isFinal = false;

    this.state.responseId = chunk.id;
    this.state.model = chunk.model;

    // Handle usage - may come with content or in a separate final chunk
    if (chunk.usage) {
      this.state.usage = {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
      };
    }

    const choice = chunk.choices[0];
    if (!choice) {
      // Empty choices with usage means this is the final chunk
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

    // Handle finish reason
    if (choice.finish_reason) {
      this.state.stopReason = choice.finish_reason;
    }

    // Only mark as final when we have BOTH finish_reason AND usage data
    // This prevents premature termination if usage comes with content chunks
    // The stream should only end after all content is delivered
    if (this.state.stopReason && this.state.usage !== null) {
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
    // Perplexity doesn't support tools
    return [];
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
          finish_reason: (this.state.stopReason as "stop" | "length") ?? "stop",
        },
      ],
    };
    return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
  }

  toProviderResponse(): PerplexityResponse {
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
    return headers.authorization;
  },

  getBaseUrl(): string | undefined {
    return config.llm.perplexity.baseUrl;
  },

  spanName: "chat",

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
          "perplexity",
          options.agent,
          options.externalAgentId,
        )
      : undefined;

    // Use OpenAI SDK with Perplexity base URL (OpenAI-compatible API)
    return new OpenAIProvider({
      apiKey,
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
    const response =
      await perplexityClient.chat.completions.create(perplexityRequest);
    return response as unknown as PerplexityResponse;
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
    const stream =
      await perplexityClient.chat.completions.create(perplexityRequest);

    return {
      [Symbol.asyncIterator]: async function* () {
        for await (const chunk of stream) {
          yield chunk as PerplexityStreamChunk;
        }
      },
    };
  },

  extractErrorMessage(error: unknown): string {
    // OpenAI SDK error structure
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
