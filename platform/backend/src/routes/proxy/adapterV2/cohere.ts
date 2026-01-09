import { encode as toonEncode } from "@toon-format/toon";
import { get } from "lodash-es";
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
    Cohere,
    LLMProvider,
    LLMRequestAdapter,
    LLMResponseAdapter,
    LLMStreamAdapter,
    StreamAccumulatorState,
    ToonCompressionResult,
    UsageView,
} from "@/types";
import { unwrapToolContent } from "../utils/unwrap-tool-content";
import type { CompressionStats } from "../utils/toon-conversion";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type CohereRequest = Cohere.Types.ChatRequest;
type CohereResponse = Cohere.Types.ChatResponse;
type CohereMessages = Cohere.Types.ChatMessage[];
type CohereHeaders = Cohere.Types.ChatHeaders;
type CohereStreamChunk = Cohere.Types.StreamChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class CohereRequestAdapter
    implements LLMRequestAdapter<CohereRequest, CohereMessages> {
    readonly provider = "cohere" as const;
    private request: CohereRequest;
    private modifiedModel: string | null = null;
    private toolResultUpdates: Record<string, string> = {};

    constructor(request: CohereRequest) {
        this.request = request;
    }

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
                let content: unknown;
                if (typeof message.content === "string") {
                    try {
                        content = JSON.parse(message.content);
                    } catch {
                        content = message.content;
                    }
                } else if (Array.isArray(message.content)) {
                    // For Cohere, content can be an array of blocks
                    content = message.content.map(c => c.text).join("");
                }

                results.push({
                    id: message.tool_call_id,
                    name: "unknown", // Cohere tool messages don't explicitly carry name
                    content,
                    isError: false,
                });
            }
        }
        return results;
    }

    getTools(): CommonMcpToolDefinition[] {
        if (!this.request.tools) return [];
        return this.request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            inputSchema: t.function.parameters as Record<string, unknown>,
        }));
    }

    hasTools(): boolean {
        return (this.request.tools?.length ?? 0) > 0;
    }

    getProviderMessages(): CohereMessages {
        return this.request.messages;
    }

    getOriginalRequest(): CohereRequest {
        return this.request;
    }

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

    toProviderRequest(): CohereRequest {
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

    private toCommonFormat(messages: CohereMessages): CommonMessage[] {
        return messages.map((m) => {
            const common: CommonMessage = {
                role: m.role as CommonMessage["role"],
            };
            if (m.role === "tool") {
                common.toolCalls = [
                    {
                        id: m.tool_call_id,
                        name: "unknown",
                        content: m.content,
                        isError: false,
                    }
                ];
            }
            return common;
        });
    }

    private applyUpdates(
        messages: CohereMessages,
        updates: Record<string, string>,
    ): CohereMessages {
        return messages.map((m) => {
            if (m.role === "tool" && updates[m.tool_call_id]) {
                return {
                    ...m,
                    content: updates[m.tool_call_id],
                };
            }
            return m;
        });
    }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class CohereResponseAdapter implements LLMResponseAdapter<CohereResponse> {
    readonly provider = "cohere" as const;
    private response: CohereResponse;

    constructor(response: CohereResponse) {
        this.response = response;
    }

    getId(): string {
        return this.response.id;
    }

    getModel(): string {
        return this.response.model;
    }

    getText(): string {
        return this.response.message?.content?.[0]?.text ?? "";
    }

    getToolCalls(): CommonToolCall[] {
        if (!this.response.message?.tool_calls) return [];
        return this.response.message.tool_calls.map((tc: any) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: typeof tc.function.arguments === "string"
                ? JSON.parse(tc.function.arguments)
                : tc.function.arguments,
        }));
    }

    hasToolCalls(): boolean {
        return (this.response.message?.tool_calls?.length ?? 0) > 0;
    }

    getUsage(): UsageView {
        const billed = this.response.usage?.billed_units;
        const tokens = this.response.usage?.tokens;
        return {
            inputTokens: billed?.input_tokens ?? tokens?.input_tokens ?? 0,
            outputTokens: billed?.output_tokens ?? tokens?.output_tokens ?? 0,
        };
    }

    getOriginalResponse(): CohereResponse {
        return this.response;
    }

    toRefusalResponse(
        _refusalMessage: string,
        contentMessage: string,
    ): CohereResponse {
        return {
            ...this.response,
            message: {
                role: "assistant",
                content: [{ type: "text", text: contentMessage }],
            },
            finish_reason: "COMPLETE",
        };
    }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class CohereStreamAdapter
    implements LLMStreamAdapter<CohereStreamChunk, CohereResponse> {
    readonly provider = "cohere" as const;
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

    processChunk(chunk: CohereStreamChunk): ChunkProcessingResult {
        if (this.state.timing.firstChunkTime === null) {
            this.state.timing.firstChunkTime = Date.now();
        }

        let sseData: string | null = null;
        let isToolCallChunk = false;
        let isFinal = false;

        switch (chunk.type) {
            case "message-start":
                this.state.responseId = chunk.id;
                // Cohere V2 doesn't always send model in start, we'll get it from messages if needed
                break;
            case "content-delta":
                if (chunk.delta.message.content) {
                    this.state.text += chunk.delta.message.content;
                    // Map Cohere content-delta to OpenAI-like format for our proxy's default behavior?
                    // Actually, handleLLMProxy sends result.sseData as-is.
                    // If we want the frontend to receive Cohere format, we send Cohere format.
                    sseData = `data: ${JSON.stringify(chunk)}\n\n`;
                }
                break;
            case "tool-call-start":
                if (chunk.delta.message.tool_calls) {
                    const tc = chunk.delta.message.tool_calls;
                    this.state.toolCalls.push({
                        id: tc.id || "",
                        name: tc.function?.name || "",
                        arguments: tc.function?.arguments || "",
                    });
                    this.state.rawToolCallEvents.push(chunk);
                    isToolCallChunk = true;
                }
                break;
            case "tool-call-delta":
                if (chunk.delta.message.tool_calls?.function?.arguments) {
                    const idx = chunk.index !== undefined ? chunk.index : this.state.toolCalls.length - 1;
                    if (this.state.toolCalls[idx]) {
                        this.state.toolCalls[idx].arguments += chunk.delta.message.tool_calls.function.arguments;
                    }
                    this.state.rawToolCallEvents.push(chunk);
                    isToolCallChunk = true;
                }
                break;
            case "tool-call-end":
                this.state.rawToolCallEvents.push(chunk);
                isToolCallChunk = true;
                break;
            case "message-end":
                if (chunk.delta?.finish_reason) {
                    this.state.stopReason = chunk.delta.finish_reason;
                }
                if (chunk.delta?.usage) {
                    const billed = chunk.delta.usage.billed_units;
                    const tokens = chunk.delta.usage.tokens;
                    this.state.usage = {
                        inputTokens: billed?.input_tokens ?? tokens?.input_tokens ?? 0,
                        outputTokens: billed?.output_tokens ?? tokens?.output_tokens ?? 0,
                    };
                }
                isFinal = true;
                break;
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
        const chunk: CohereStreamChunk = {
            type: "content-delta",
            index: 0,
            delta: {
                message: {
                    content: text,
                },
            },
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    getRawToolCallEvents(): string[] {
        return this.state.rawToolCallEvents.map(
            (event) => `data: ${JSON.stringify(event)}\n\n`,
        );
    }

    formatCompleteTextSSE(text: string): string[] {
        const start: CohereStreamChunk = {
            type: "message-start",
            id: this.state.responseId || `msg-${Date.now()}`,
            delta: { message: { role: "assistant" } }
        };
        const chunk: CohereStreamChunk = {
            type: "content-delta",
            index: 0,
            delta: {
                message: {
                    content: text,
                },
            },
        };
        const end: CohereStreamChunk = {
            type: "message-end",
            delta: { finish_reason: "COMPLETE" }
        };
        return [
            `data: ${JSON.stringify(start)}\n\n`,
            `data: ${JSON.stringify(chunk)}\n\n`,
            `data: ${JSON.stringify(end)}\n\n`
        ];
    }

    formatEndSSE(): string {
        return "data: [DONE]\n\n";
    }

    toProviderResponse(): CohereResponse {
        return {
            id: this.state.responseId,
            model: this.state.model,
            message: {
                role: "assistant",
                content: [{ type: "text", text: this.state.text }],
                tool_calls: this.state.toolCalls.map(tc => ({
                    id: tc.id,
                    type: "function",
                    function: {
                        name: tc.name,
                        arguments: tc.arguments
                    }
                }))
            },
            usage: this.state.usage ? {
                billed_units: {
                    input_tokens: this.state.usage.inputTokens,
                    output_tokens: this.state.usage.outputTokens
                }
            } : undefined,
            finish_reason: (this.state.stopReason as any) || "COMPLETE",
        };
    }
}

// =============================================================================
// ADAPTER FACTORY
// =============================================================================

export const cohereAdapterFactory: LLMProvider<
    CohereRequest,
    CohereResponse,
    CohereMessages,
    CohereStreamChunk,
    CohereHeaders
> = {
    provider: "cohere",
    interactionType: "cohere:chat",

    createRequestAdapter(
        request: CohereRequest,
    ): LLMRequestAdapter<CohereRequest, CohereMessages> {
        return new CohereRequestAdapter(request);
    },

    createResponseAdapter(
        response: CohereResponse,
    ): LLMResponseAdapter<CohereResponse> {
        return new CohereResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<CohereStreamChunk, CohereResponse> {
        return new CohereStreamAdapter();
    },

    extractApiKey(headers: CohereHeaders): string | undefined {
        return headers.Authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.cohere.baseUrl;
    },

    getSpanName(): string {
        return "cohere.chat";
    },

    createClient(
        apiKey: string | undefined,
        _options?: any,
    ): any {
        // We'll use fetch directly in execute/executeStream, but we return the API key as the "client"
        return { apiKey };
    },

    async execute(client: any, request: CohereRequest): Promise<CohereResponse> {
        const url = this.getBaseUrl() + "/chat";
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": client.apiKey,
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Cohere API error: ${response.status}`);
        }

        return await response.json();
    },

    async executeStream(
        client: any,
        request: CohereRequest,
    ): Promise<AsyncIterable<CohereStreamChunk>> {
        const url = this.getBaseUrl() + "/chat";
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": client.apiKey,
            },
            body: JSON.stringify({ ...request, stream: true }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `Cohere API error: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("No response body from Cohere API");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        return {
            [Symbol.asyncIterator]: async function* () {
                let buffer = "";
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split("\n");
                    buffer = lines.pop() || "";

                    for (const line of lines) {
                        if (!line.trim() || line.startsWith(":")) continue;
                        if (line.startsWith("data: ")) {
                            const data = line.slice(6).trim();
                            if (data === "[DONE]") return;
                            try {
                                yield JSON.parse(data);
                            } catch (e) {
                                logger.error({ line, error: e }, "Failed to parse Cohere SSE chunk");
                            }
                        }
                    }
                }
            },
        };
    },

    extractErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        return "Internal server error";
    },
};

// =============================================================================
// TOON COMPRESSION
// =============================================================================

async function convertToolResultsToToon(
    messages: CohereMessages,
    model: string,
): Promise<{
    messages: CohereMessages;
    stats: CompressionStats;
}> {
    const tokenizer = getTokenizer("openai"); // Fallback to openai tokenizer if no cohere one
    let toolResultCount = 0;
    let totalTokensBefore = 0;
    let totalTokensAfter = 0;

    const result = messages.map((message) => {
        if (message.role === "tool") {
            toolResultCount++;
            if (typeof message.content === "string") {
                try {
                    const unwrapped = unwrapToolContent(message.content);
                    const parsed = JSON.parse(unwrapped);
                    const compressed = toonEncode(parsed);

                    const tokensBefore = tokenizer.countTokens([{ role: "user", content: unwrapped }]);
                    const tokensAfter = tokenizer.countTokens([{ role: "user", content: compressed }]);

                    totalTokensBefore += tokensBefore;
                    totalTokensAfter += tokensAfter;

                    return { ...message, content: compressed };
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
                const inputPricePerToken = Number(tokenPrice.pricePerMillionInput) / 1000000;
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
