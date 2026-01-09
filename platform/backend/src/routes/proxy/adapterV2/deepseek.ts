import DeepSeek from "@/types/llm-providers/deepseek";
import config from "@/config";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
} from "./openai";
import type {
    LLMProvider,
    LLMRequestAdapter,
    LLMResponseAdapter,
    LLMStreamAdapter,
} from "@/types";

class DeepSeekRequestAdapter extends OpenAIRequestAdapter {
    readonly provider = "deepseek" as const;
}

class DeepSeekResponseAdapter extends OpenAIResponseAdapter {
    readonly provider = "deepseek" as const;
}

class DeepSeekStreamAdapter extends OpenAIStreamAdapter {
    readonly provider = "deepseek" as const;
}

export const deepseekAdapterFactory: LLMProvider<
    DeepSeek.Types.ChatRequest,
    DeepSeek.Types.ChatResponse,
    DeepSeek.Types.ChatRequest["messages"],
    DeepSeek.Types.StreamChunk,
    DeepSeek.Types.ChatHeaders
> = {
    provider: "deepseek",
    interactionType: "deepseek:chat",

    createRequestAdapter(
        request: DeepSeek.Types.ChatRequest,
    ): LLMRequestAdapter<DeepSeek.Types.ChatRequest, DeepSeek.Types.ChatRequest["messages"]> {
        return new DeepSeekRequestAdapter(request);
    },

    createResponseAdapter(
        response: DeepSeek.Types.ChatResponse,
    ): LLMResponseAdapter<DeepSeek.Types.ChatResponse> {
        return new DeepSeekResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        DeepSeek.Types.StreamChunk,
        DeepSeek.Types.ChatResponse
    > {
        return new DeepSeekStreamAdapter();
    },

    extractApiKey(headers: DeepSeek.Types.ChatHeaders): string | undefined {
        return headers.authorization?.replace("Bearer ", "");
    },

    getBaseUrl(): string {
        return config.llm.deepseek.baseUrl;
    },

    getSpanName(): string {
        return "deepseek-chat";
    },

    createClient(apiKey: string | undefined): any {
        return { apiKey };
    },

    async execute(client: any, request: DeepSeek.Types.ChatRequest): Promise<DeepSeek.Types.ChatResponse> {
        const url = `${this.getBaseUrl()}/chat/completions`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${client.apiKey}`,
            },
            body: JSON.stringify(request),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `DeepSeek API error: ${response.status}`);
        }

        return response.json();
    },

    async executeStream(
        client: any,
        request: DeepSeek.Types.ChatRequest,
    ): Promise<AsyncIterable<DeepSeek.Types.StreamChunk>> {
        const url = `${this.getBaseUrl()}/chat/completions`;
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${client.apiKey}`,
            },
            body: JSON.stringify({ ...request, stream: true }),
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || `DeepSeek API error: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("No response body from DeepSeek API");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        return {
            [Symbol.asyncIterator]: async function* () {
                let buffer = "";
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split("\n");
                        buffer = lines.pop() || "";

                        for (const line of lines) {
                            const trimmed = line.trim();
                            if (!trimmed || !trimmed.startsWith("data: ")) continue;

                            const data = trimmed.slice(6);
                            if (data === "[DONE]") return;

                            try {
                                yield JSON.parse(data);
                            } catch (e) {
                                console.error("Failed to parse DeepSeek SSE chunk", { line, error: e });
                            }
                        }
                    }
                } finally {
                    reader.releaseLock();
                }
            },
        };
    },

    extractErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        return String(error);
    }
};
