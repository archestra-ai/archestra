import { OpenAIRequestAdapter, OpenAIResponseAdapter, OpenAIStreamAdapter } from "./openai";
import { DeepSeek } from "@/types/llm-providers/deepseek";
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
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.deepseek?.baseUrl;
    },

    getSpanName(streaming: boolean): string {
        return `deepseek.chat${streaming ? ".stream" : ""}`;
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
        request: DeepSeek.Types.ChatRequest,
    ): Promise<DeepSeek.Types.ChatResponse> {
        const response = await client.chat(request.model).doChat(request);
        return response.rawResponse as DeepSeek.Types.ChatResponse;
    },

    async executeStream(
        client: any,
        request: DeepSeek.Types.ChatRequest,
    ): Promise<AsyncIterable<DeepSeek.Types.StreamChunk>> {
        const { stream } = await client.chat(request.model).doStream(request);
        return stream as AsyncIterable<DeepSeek.Types.StreamChunk>;
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
