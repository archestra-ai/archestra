import Groq from "@/types/llm-providers/groq";
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

class GroqRequestAdapter extends OpenAIRequestAdapter {
    readonly provider = "groq" as const;
}

class GroqResponseAdapter extends OpenAIResponseAdapter {
    readonly provider = "groq" as const;
}

class GroqStreamAdapter extends OpenAIStreamAdapter {
    readonly provider = "groq" as const;
}

export const groqAdapterFactory: LLMProvider<
    Groq.Types.ChatRequest,
    Groq.Types.ChatResponse,
    Groq.Types.ChatRequest["messages"],
    Groq.Types.StreamChunk,
    Groq.Types.ChatHeaders
> = {
    provider: "groq",
    interactionType: "groq:chat",

    createRequestAdapter(
        request: Groq.Types.ChatRequest,
    ): LLMRequestAdapter<Groq.Types.ChatRequest, Groq.Types.ChatRequest["messages"]> {
        return new GroqRequestAdapter(request);
    },

    createResponseAdapter(
        response: Groq.Types.ChatResponse,
    ): LLMResponseAdapter<Groq.Types.ChatResponse> {
        return new GroqResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        Groq.Types.StreamChunk,
        Groq.Types.ChatResponse
    > {
        return new GroqStreamAdapter();
    },

    extractApiKey(headers: Groq.Types.ChatHeaders): string | undefined {
        return headers.authorization?.replace("Bearer ", "");
    },

    getBaseUrl(): string {
        return config.llm.groq.baseUrl;
    },

    getSpanName(): string {
        return "groq-chat";
    },

    createClient(apiKey: string | undefined): any {
        return { apiKey };
    },

    async execute(client: any, request: Groq.Types.ChatRequest): Promise<Groq.Types.ChatResponse> {
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
            throw new Error(error.error?.message || error.message || `Groq API error: ${response.status}`);
        }

        return response.json();
    },

    async executeStream(
        client: any,
        request: Groq.Types.ChatRequest,
    ): Promise<AsyncIterable<Groq.Types.StreamChunk>> {
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
            throw new Error(error.error?.message || error.message || `Groq API error: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("No response body from Groq API");
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
                                console.error("Failed to parse Groq SSE chunk", { line, error: e });
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
