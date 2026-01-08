/**
 * OpenRouter Adapter Implementation
 *
 * OpenRouter uses OpenAI-compatible API format, so this adapter closely follows
 * the OpenAI adapter implementation. Key differences:
 * - Different base URL (openrouter.ai/api/v1)
 * - Optional HTTP-Referer and X-Title headers for app attribution
 * - Model names include provider prefix (e.g., "openai/gpt-4", "anthropic/claude-3-opus")
 */
import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
import OpenAIProvider from "openai";
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
    OpenRouter,
    StreamAccumulatorState,
    ToonCompressionResult,
    UsageView,
} from "@/types";
import { MockOpenAIClient } from "../mock-openai-client";
import type { CompressionStats } from "../utils/toon-conversion";
import { unwrapToolContent } from "../utils/unwrap-tool-content";

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
    implements LLMRequestAdapter<OpenRouterRequest, OpenRouterMessages> {
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
                            return toolCall.custom.name;
                        }
                    }
                }
            }
        }

        return null;
    }

    private toCommonFormat(messages: OpenRouterMessages): CommonMessage[] {
        logger.debug(
            { messageCount: messages.length },
            "[OpenRouterAdapter] toCommonFormat: starting conversion",
        );
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
                    logger.debug(
                        { toolCallId: message.tool_call_id, toolName },
                        "[OpenRouterAdapter] toCommonFormat: found tool message",
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
            "[OpenRouterAdapter] toCommonFormat: conversion complete",
        );
        return commonMessages;
    }

    private applyUpdates(
        messages: OpenRouterMessages,
        updates: Record<string, string>,
    ): OpenRouterMessages {
        const updateCount = Object.keys(updates).length;
        logger.debug(
            { messageCount: messages.length, updateCount },
            "[OpenRouterAdapter] applyUpdates: starting",
        );

        if (updateCount === 0) {
            logger.debug("[OpenRouterAdapter] applyUpdates: no updates to apply");
            return messages;
        }

        let appliedCount = 0;
        const result = messages.map((message) => {
            if (message.role === "tool" && updates[message.tool_call_id]) {
                appliedCount++;
                logger.debug(
                    { toolCallId: message.tool_call_id },
                    "[OpenRouterAdapter] applyUpdates: applying update to tool message",
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
            "[OpenRouterAdapter] applyUpdates: complete",
        );
        return result;
    }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class OpenRouterResponseAdapter
    implements LLMResponseAdapter<OpenRouterResponse> {
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

class OpenRouterStreamAdapter
    implements LLMStreamAdapter<OpenRouterStreamChunk, OpenRouterResponse> {
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
        const chunk: OpenRouterStreamChunk = {
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
        const chunk: OpenRouterStreamChunk = {
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
        const finalChunk: OpenRouterStreamChunk = {
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

    toProviderResponse(): OpenRouterResponse {
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
                        (this.state.stopReason as OpenRouter.Types.FinishReason) ?? "stop",
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
    messages: OpenRouterMessages,
    model: string,
): Promise<{
    messages: OpenRouterMessages;
    stats: CompressionStats;
}> {
    // Use openai tokenizer since OpenRouter uses OpenAI-compatible format
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
                    provider: "openrouter",
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
                            provider: "openrouter",
                        },
                        "convertToolResultsToToon: compressed",
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

export const openrouterAdapterFactory: LLMProvider<
    OpenRouterRequest,
    OpenRouterResponse,
    OpenRouterMessages,
    OpenRouterStreamChunk,
    OpenRouterHeaders
> = {
    provider: "openrouter",
    interactionType: "openrouter:chatCompletions",

    createRequestAdapter(
        request: OpenRouterRequest,
    ): LLMRequestAdapter<OpenRouterRequest, OpenRouterMessages> {
        return new OpenRouterRequestAdapter(request);
    },

    createResponseAdapter(
        response: OpenRouterResponse,
    ): LLMResponseAdapter<OpenRouterResponse> {
        return new OpenRouterResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        OpenRouterStreamChunk,
        OpenRouterResponse
    > {
        return new OpenRouterStreamAdapter();
    },

    extractApiKey(headers: OpenRouterHeaders): string | undefined {
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.openrouter.baseUrl;
    },

    getSpanName(): string {
        return "openrouter.chat.completions";
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
            ? getObservableFetch("openrouter", options.agent, options.externalAgentId)
            : undefined;

        // OpenRouter uses OpenAI-compatible SDK
        return new OpenAIProvider({
            apiKey,
            baseURL: options?.baseUrl || config.llm.openrouter.baseUrl,
            fetch: customFetch,
            defaultHeaders: {
                // Optional OpenRouter-specific headers for app attribution
                "HTTP-Referer": "https://archestra.ai",
                "X-Title": "Archestra Platform",
            },
        });
    },

    async execute(
        client: unknown,
        request: OpenRouterRequest,
    ): Promise<OpenRouterResponse> {
        const openaiClient = client as OpenAIProvider;
        return openaiClient.chat.completions.create({
            ...request,
            stream: false,
        }) as Promise<OpenRouterResponse>;
    },

    async executeStream(
        client: unknown,
        request: OpenRouterRequest,
    ): Promise<AsyncIterable<OpenRouterStreamChunk>> {
        const openaiClient = client as OpenAIProvider;
        const stream = await openaiClient.chat.completions.create({
            ...request,
            stream: true,
            stream_options: { include_usage: true },
        });

        return {
            [Symbol.asyncIterator]: async function* () {
                for await (const chunk of stream) {
                    yield chunk as OpenRouterStreamChunk;
                }
            },
        };
    },

    extractErrorMessage(error: unknown): string {
        // OpenRouter uses OpenAI-compatible error structure
        const openrouterMessage = get(error, "error.message");
        if (typeof openrouterMessage === "string") {
            return openrouterMessage;
        }

        if (error instanceof Error) {
            return error.message;
        }

        return "Internal server error";
    },
};
