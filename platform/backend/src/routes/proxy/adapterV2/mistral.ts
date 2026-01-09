import Mistral from "@/types/llm-providers/mistral";
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
} from "./types";

class MistralRequestAdapter extends OpenAIRequestAdapter {
    readonly provider = "mistral" as const;
}

class MistralResponseAdapter extends OpenAIResponseAdapter {
    readonly provider = "mistral" as const;
}

class MistralStreamAdapter extends OpenAIStreamAdapter {
    readonly provider = "mistral" as const;
}

export const mistralAdapterFactory: LLMProvider<
    Mistral.API.ChatRequest,
    Mistral.API.ChatResponse,
    Mistral.Messages.ChatMessage[],
    Mistral.API.StreamChunk,
    Mistral.API.ChatHeaders
> = {
    provider: "mistral",
    interactionType: "mistral:chat",

    createRequestAdapter(
        request: Mistral.API.ChatRequest,
    ): LLMRequestAdapter<Mistral.API.ChatRequest, Mistral.Messages.ChatMessage[]> {
        return new MistralRequestAdapter(request);
    }

  createResponseAdapter(
        response: Mistral.API.ChatResponse,
    ): LLMResponseAdapter<Mistral.API.ChatResponse> {
        return new MistralResponseAdapter(response);
    }

  createStreamAdapter(): LLMStreamAdapter<
        Mistral.API.StreamChunk,
        Mistral.API.ChatResponse
    > {
        return new MistralStreamAdapter();
    }

  extractApiKey(headers: Mistral.API.ChatHeaders): string | undefined {
        return headers.Authorization?.replace("Bearer ", "");
    }

  getBaseUrl(): string {
        return config.llm.mistral.baseUrl;
    }

  getSpanName(): string {
        return "mistral-chat";
    }

  createClient(apiKey: string | undefined): any {
        return { apiKey };
    }

  async execute(client: any, request: Mistral.API.ChatRequest): Promise<Mistral.API.ChatResponse> {
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
            throw new Error(error.message || `Mistral API error: ${response.status}`);
        }

        return response.json();
    }

  async *executeStream(
        client: any,
        request: Mistral.API.ChatRequest,
    ): AsyncIterable<Mistral.API.StreamChunk> {
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
            throw new Error(error.message || `Mistral API error: ${response.status}`);
        }

        if (!response.body) {
            throw new Error("No response body from Mistral API");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
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
                        console.error("Failed to parse Mistral SSE chunk", { line, error: e });
                    }
                }
            }
        } finally {
            reader.releaseLock();
        }
    }

  extractErrorMessage(error: unknown): string {
        if (error instanceof Error) return error.message;
        return String(error);
    }
};
