import { OpenAIRequestAdapter, OpenAIResponseAdapter, OpenAIStreamAdapter } from "./openai";
import { MiniMax } from "@/types/llm-providers/minimax";
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

class MiniMaxRequestAdapter extends OpenAIRequestAdapter {
    readonly provider = "minimax" as const;
}

class MiniMaxResponseAdapter extends OpenAIResponseAdapter {
    readonly provider = "minimax" as const;
}

class MiniMaxStreamAdapter extends OpenAIStreamAdapter {
    readonly provider = "minimax" as const;
}

export const minimaxAdapterFactory: LLMProvider<
    MiniMax.Types.ChatRequest,
    MiniMax.Types.ChatResponse,
    MiniMax.Types.ChatRequest["messages"],
    MiniMax.Types.StreamChunk,
    MiniMax.Types.ChatHeaders
> = {
    provider: "minimax",
    interactionType: "minimax:chat",

    createRequestAdapter(
        request: MiniMax.Types.ChatRequest,
    ): LLMRequestAdapter<MiniMax.Types.ChatRequest, MiniMax.Types.ChatRequest["messages"]> {
        return new MiniMaxRequestAdapter(request);
    },

    createResponseAdapter(
        response: MiniMax.Types.ChatResponse,
    ): LLMResponseAdapter<MiniMax.Types.ChatResponse> {
        return new MiniMaxResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        MiniMax.Types.StreamChunk,
        MiniMax.Types.ChatResponse
    > {
        return new MiniMaxStreamAdapter();
    },

    extractApiKey(headers: MiniMax.Types.ChatHeaders): string | undefined {
        // OpenAI headers schema handles authorization parsing
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.minimax.baseUrl;
    },

    getSpanName(streaming: boolean): string {
        return `minimax.chat${streaming ? ".stream" : ""}`;
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
            // userId is optional on some agent types in the system
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
        request: MiniMax.Types.ChatRequest,
    ): Promise<MiniMax.Types.ChatResponse> {
        const response = await client.chat(request.model).doChat(request);
        return response.rawResponse as MiniMax.Types.ChatResponse;
    },

    async executeStream(
        client: any,
        request: MiniMax.Types.ChatRequest,
    ): Promise<AsyncIterable<MiniMax.Types.StreamChunk>> {
        const { stream } = await client.chat(request.model).doStream(request);
        return stream as AsyncIterable<MiniMax.Types.StreamChunk>;
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
