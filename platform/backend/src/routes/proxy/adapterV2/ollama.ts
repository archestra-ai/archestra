import { get } from "lodash-es";
import OpenAIProvider from "openai";
import type {
    ChatCompletionCreateParamsNonStreaming,
    ChatCompletionCreateParamsStreaming,
} from "openai/resources/chat/completions/completions";
import type {
    OpenAi,
    LLMProvider,
    LLMRequestAdapter,
    LLMResponseAdapter,
    LLMStreamAdapter,
    ChunkProcessingResult,
    UsageView,
    StreamAccumulatorState,
    CommonMessage,
    CommonToolCall,
    CommonMcpToolDefinition,
    CommonToolResult,
    CreateClientOptions,
} from "@/types";
import logger from "@/logging";
import config from "@/config";
import { estimateMessagesSize } from "@/utils/message-size";
import { stripBrowserToolsResults } from "../utils/summarize-tool-results";
import { getObservableFetch } from "@/llm-metrics";

// =============================================================================
// TYPE ALIASES
// =============================================================================

type OpenAiRequest = OpenAi.Types.ChatCompletionsRequest;
type OpenAiResponse = OpenAi.Types.ChatCompletionsResponse;
type OpenAiMessages = OpenAi.Types.ChatCompletionsRequest["messages"];
type OpenAiHeaders = OpenAi.Types.ChatCompletionsHeaders;
type OpenAiStreamChunk = OpenAi.Types.ChatCompletionChunk;

// =============================================================================
// REQUEST ADAPTER
// =============================================================================

class OllamaRequestAdapter
    implements LLMRequestAdapter<OpenAiRequest, OpenAiMessages> {
    readonly provider = "ollama" as const;
    private request: OpenAiRequest;
    private modifiedModel: string | null = null;
    private toolResultUpdates: Record<string, string> = {};

    constructor(request: OpenAiRequest) {
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

    setModel(model: string): void {
        this.modifiedModel = model;
    }

    updateToolResult(toolCallId: string, newContent: string): void {
        this.toolResultUpdates[toolCallId] = newContent;
    }

    applyToolResultUpdates(updates: Record<string, string>): void {
        Object.assign(this.toolResultUpdates, updates);
    }

    async applyToonCompression(_model: string): Promise<any> {
        return {
            tokensBefore: 0,
            tokensAfter: 0,
            costSavings: 0,
        };
    }

    convertToolResultContent(messages: OpenAiMessages): OpenAiMessages {
        // Ollama usually doesn't need special translation for tool result content like images yet
        // unless we want to strip them if the model doesn't support them.
        // For now, return as is.
        return messages;
    }

    toProviderRequest(): OpenAiRequest {
        let messages = this.request.messages;

        if (Object.keys(this.toolResultUpdates).length > 0) {
            messages = this.applyUpdates(messages, this.toolResultUpdates);
        }

        if (config.features.browserStreamingEnabled) {
            messages = stripBrowserToolsResults(messages);
        }

        const requestSize = estimateMessagesSize(messages);
        const requestSizeKB = Math.round(requestSize.length / 1024);

        logger.info(
            {
                model: this.getModel(),
                messageCount: messages.length,
                requestSizeKB,
                hasToolResultUpdates: Object.keys(this.toolResultUpdates).length > 0,
            },
            "[OllamaAdapter] Building provider request",
        );

        return {
            ...this.request,
            model: this.getModel(),
            messages,
        };
    }

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
                        }
                    }
                }
            }
        }
        return null;
    }

    private toCommonFormat(messages: OpenAiMessages): CommonMessage[] {
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
        messages: OpenAiMessages,
        updates: Record<string, string>,
    ): OpenAiMessages {
        return messages.map((message) => {
            if (message.role === "tool" && updates[message.tool_call_id]) {
                return {
                    ...message,
                    content: updates[message.tool_call_id],
                };
            }
            return message;
        });
    }
}

// =============================================================================
// RESPONSE ADAPTER
// =============================================================================

class OllamaResponseAdapter implements LLMResponseAdapter<OpenAiResponse> {
    readonly provider = "ollama" as const;
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
                    } as any,
                    finish_reason: "stop",
                },
            ],
        };
    }
}

// =============================================================================
// STREAM ADAPTER
// =============================================================================

class OllamaStreamAdapter
    implements LLMStreamAdapter<OpenAiStreamChunk, OpenAiResponse> {
    readonly provider = "ollama" as const;
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

    processChunk(chunk: OpenAiStreamChunk): ChunkProcessingResult {
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
            sseData = delta.content;
        }

        if (delta.tool_calls) {
            isToolCallChunk = true;
            for (const toolCallDelta of delta.tool_calls) {
                const index = toolCallDelta.index;
                let toolCall = this.state.toolCalls[index];

                if (!toolCall) {
                    toolCall = {
                        id: toolCallDelta.id ?? `call_${Date.now()}_${index}`,
                        name: toolCallDelta.function?.name ?? "",
                        arguments: "",
                    };
                    this.state.toolCalls[index] = toolCall;
                }

                if (toolCallDelta.function?.name) {
                    toolCall.name += toolCallDelta.function.name;
                }

                if (toolCallDelta.function?.arguments) {
                    toolCall.arguments += toolCallDelta.function.arguments;
                }
            }
            this.state.rawToolCallEvents.push(chunk);
        }

        if (choice.finish_reason) {
            this.state.stopReason = choice.finish_reason;
            isFinal = true;
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
                    logprobs: null,
                },
            ],
        };
        return `data: ${JSON.stringify(chunk)}\n\n`;
    }

    getRawToolCallEvents(): (string | object)[] {
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
                    } as any,
                    finish_reason: null,
                    logprobs: null,
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
                        (this.state.stopReason as any) ?? "stop",
                    logprobs: null,
                },
            ],
        };
        return `data: ${JSON.stringify(finalChunk)}\n\ndata: [DONE]\n\n`;
    }

    toProviderResponse(): OpenAiResponse {
        return {
            id: this.state.responseId,
            model: this.state.model,
            object: "chat.completion",
            created: Math.floor(this.state.timing.startTime / 1000),
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
                                        arguments:
                                            typeof tc.arguments === "string"
                                                ? tc.arguments
                                                : JSON.stringify(tc.arguments),
                                    },
                                }))
                                : undefined,
                    } as any,
                    finish_reason: this.state.stopReason as any,
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

    getAccumulatedResponse(): OpenAiResponse {
        return this.toProviderResponse();
    }
}

// =============================================================================
// PROVIDER IMPLEMENTATION
// =============================================================================

export const ollamaAdapterFactory: LLMProvider<
    OpenAiRequest,
    OpenAiResponse,
    OpenAiMessages,
    OpenAiStreamChunk,
    OpenAiHeaders
> = {
    provider: "ollama",
    interactionType: "ollama:chatCompletions",

    createRequestAdapter: (request: OpenAiRequest) => new OllamaRequestAdapter(request),
    createResponseAdapter: (response: OpenAiResponse) => new OllamaResponseAdapter(response),
    createStreamAdapter: () => new OllamaStreamAdapter(),

    extractApiKey(headers: OpenAiHeaders): string | undefined {
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.ollama.baseUrl;
    },

    getSpanName(): string {
        return "ollama.chat.completions";
    },

    async createClient(apiKey: string | undefined, options?: CreateClientOptions) {
        const baseURL = options?.baseUrl || config.llm.ollama.baseUrl;

        const observableFetch = options?.agent
            ? getObservableFetch("ollama", options.agent, options.externalAgentId)
            : undefined;

        return new OpenAIProvider({
            apiKey: apiKey || "ollama",
            baseURL,
            fetch: observableFetch as any,
        });
    },

    async executeStream(client: unknown, request: OpenAiRequest) {
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

    async execute(client: unknown, request: OpenAiRequest) {
        const openaiClient = client as OpenAIProvider;
        const openaiRequest = {
            ...request,
            stream: false,
        } as unknown as ChatCompletionCreateParamsNonStreaming;
        const response = await openaiClient.chat.completions.create(openaiRequest);
        return response as OpenAiResponse;
    },

    extractErrorMessage(error: unknown): string {
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

export default ollamaAdapterFactory;
