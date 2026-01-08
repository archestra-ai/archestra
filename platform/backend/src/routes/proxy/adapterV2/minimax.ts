import { encode as toonEncode } from "@toon-format/toon";
import OpenAIProvider from "openai";
import config from "@/config";
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
    MiniMax,
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

type MiniMaxRequest = MiniMax.Types.ChatCompletionsRequest;
type MiniMaxResponse = MiniMax.Types.ChatCompletionsResponse;
type MiniMaxMessages = MiniMax.Types.ChatCompletionsRequest["messages"];
type MiniMaxHeaders = MiniMax.Types.ChatCompletionsHeaders;
type MiniMaxStreamChunk = MiniMax.Types.ChatCompletionChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class MiniMaxRequestAdapter
    implements LLMRequestAdapter<MiniMaxRequest, MiniMaxMessages> {
    readonly provider = "minimax" as const;
    private request: MiniMaxRequest;
    private modifiedModel: string | null = null;
    private toolResultUpdates: Record<string, string> = {};

    constructor(request: MiniMaxRequest) {
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

    getProviderMessages(): MiniMaxMessages {
        return this.request.messages;
    }

    getOriginalRequest(): MiniMaxRequest {
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
        // MiniMax uses structured tokens similar to OpenAI, so we can reuse the logic
        // We use "openai" tokenizer for now since MiniMax is OpenAI compatible
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

    toProviderRequest(): MiniMaxRequest {
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
        messages: MiniMaxMessages,
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

    private toCommonFormat(messages: MiniMaxMessages): CommonMessage[] {
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
        messages: MiniMaxMessages,
        updates: Record<string, string>,
    ): MiniMaxMessages {
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

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class MiniMaxResponseAdapter implements LLMResponseAdapter<MiniMaxResponse> {
    readonly provider = "minimax" as const;
    private response: MiniMaxResponse;

    constructor(response: MiniMaxResponse) {
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

    getOriginalResponse(): MiniMaxResponse {
        return this.response;
    }

    toRefusalResponse(
        _refusalMessage: string,
        contentMessage: string,
    ): MiniMaxResponse {
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

class MiniMaxStreamAdapter
    implements LLMStreamAdapter<MiniMaxStreamChunk, MiniMaxResponse> {
    readonly provider = "minimax" as const;
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

    processChunk(chunk: MiniMaxStreamChunk): ChunkProcessingResult {
        if (this.state.timing.firstChunkTime === null) {
            this.state.timing.firstChunkTime = Date.now();
        }

        let sseData: string | null = null;
        let isToolCallChunk = false;
        let isFinal = false;

        this.state.responseId = chunk.id;
        this.state.model = chunk.model;

        // Handle usage first - OpenAI sends usage in a final chunk with empty choices[]
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
        const chunk: MiniMaxStreamChunk = {
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
        const chunk: MiniMaxStreamChunk = {
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
        const finalChunk: MiniMaxStreamChunk = {
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

    toProviderResponse(): MiniMaxResponse {
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
                        (this.state.stopReason as MiniMax.Types.FinishReason) ?? "stop",
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
    messages: MiniMaxMessages,
    model: string,
): Promise<{
    messages: MiniMaxMessages;
    stats: CompressionStats;
}> {
    // Use OpenAI tokenizer as fallback for MiniMax (OpenAI compatible)
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

export const minimaxAdapterFactory: LLMProvider<
    MiniMaxRequest,
    MiniMaxResponse,
    MiniMaxMessages,
    MiniMaxStreamChunk,
    MiniMaxHeaders
> = {
    provider: "minimax",
    interactionType: "minimax:chatCompletions",

    createRequestAdapter(
        request: MiniMaxRequest,
    ): LLMRequestAdapter<MiniMaxRequest, MiniMaxMessages> {
        return new MiniMaxRequestAdapter(request);
    },

    createResponseAdapter(
        response: MiniMaxResponse,
    ): LLMResponseAdapter<MiniMaxResponse> {
        return new MiniMaxResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<MiniMaxStreamChunk, MiniMaxResponse> {
        return new MiniMaxStreamAdapter();
    },

    extractApiKey(headers: MiniMaxHeaders): string | undefined {
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.minimax.baseUrl;
    },

    getSpanName(): string {
        return "minimax.chat.completions";
    },

    createClient(
        apiKey: string | undefined,
        options?: CreateClientOptions,
    ): unknown {
        if (options?.mockMode) {
            return new MockOpenAIClient() as unknown;
        }

        // MiniMax uses OpenAI-compatible SDK
        return new OpenAIProvider({
            apiKey: apiKey,
            baseURL: options?.baseUrl || config.llm.minimax.baseUrl,
            defaultHeaders: options?.defaultHeaders,
        });
    },

    async execute(client: unknown, request: MiniMaxRequest): Promise<MiniMaxResponse> {
        const openai = client as OpenAIProvider;
        // @ts-ignore - OpenAI type mismatch with MiniMax mostly compatible
        return await openai.chat.completions.create(request);
    },

    async executeStream(
        client: unknown,
        request: MiniMaxRequest,
    ): Promise<AsyncIterable<MiniMaxStreamChunk>> {
        const openai = client as OpenAIProvider;
        // @ts-ignore - OpenAI type mismatch with MiniMax mostly compatible
        const stream = await openai.chat.completions.create({
            ...request,
            stream: true,
            stream_options: { include_usage: true },
        });
        return stream as AsyncIterable<MiniMaxStreamChunk>;
    },

    extractErrorMessage(error: unknown): string {
        if (error instanceof OpenAIProvider.APIError) {
            return error.message;
        }
        return String(error);
    },
};
