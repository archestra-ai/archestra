import { OpenAIRequestAdapter, OpenAIResponseAdapter, OpenAIStreamAdapter } from "./openai";
import { Groq } from "@/types/llm-providers/groq";
import type {
    LLMProvider,
    LLMRequestAdapter,
    LLMResponseAdapter,
    LLMStreamAdapter,
    CreateClientOptions,
} from "@/types/llm-provider";
import config from "@/config";
import { createOpenAI } from "@ai-sdk/openai";
import { EXTERNAL_AGENT_ID_HEADER, USER_ID_HEADER } from "@shared";

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
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.groq?.baseUrl;
    },

    getSpanName(streaming: boolean): string {
        return `groq.chat${streaming ? ".stream" : ""}`;
    },

    createClient(
        apiKey: string | undefined,
        options?: CreateClientOptions,
    ): any {
        const { baseUrl, agent, externalAgentId, defaultHeaders } = options || {};

        const headers: Record<string, string> = {
            ...defaultHeaders,
        };

        if (externalAgentId) {
            headers[EXTERNAL_AGENT_ID_HEADER] = externalAgentId;
        }

        if (agent && "userId" in agent) {
            const agentWithUserId = agent as { userId?: string };
            if (agentWithUserId.userId) {
                headers[USER_ID_HEADER] = agentWithUserId.userId;
            }
        }

        return createOpenAI({
            apiKey,
            baseURL: baseUrl || this.getBaseUrl(),
            headers,
        });
    },

    async execute(
        client: any,
        request: Groq.Types.ChatRequest,
    ): Promise<Groq.Types.ChatResponse> {
        const response = await client.chat(request.model).doChat(request);
        return response.rawResponse as Groq.Types.ChatResponse;
    },

    async executeStream(
        client: any,
        request: Groq.Types.ChatRequest,
    ): Promise<AsyncIterable<Groq.Types.StreamChunk>> {
        const { stream } = await client.chat(request.model).doStream(request);
        return stream as AsyncIterable<Groq.Types.StreamChunk>;
    },

    extractErrorMessage(error: any): string {
        if (error.response?.data?.error?.message) {
            return error.response.data.error.message;
        }
        if (error.message) {
            return error.message;
        }
        return String(error);
    },
};
