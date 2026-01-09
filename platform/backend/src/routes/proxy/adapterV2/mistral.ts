import { OpenAIRequestAdapter, OpenAIResponseAdapter, OpenAIStreamAdapter } from "./openai";
import { Mistral } from "@/types/llm-providers/mistral";
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
    Mistral.Types.ChatRequest,
    Mistral.Types.ChatResponse,
    Mistral.Types.ChatRequest["messages"],
    Mistral.Types.StreamChunk,
    Mistral.Types.ChatHeaders
> = {
    provider: "mistral",
    interactionType: "mistral:chat",

    createRequestAdapter(
        request: Mistral.Types.ChatRequest,
    ): LLMRequestAdapter<Mistral.Types.ChatRequest, Mistral.Types.ChatRequest["messages"]> {
        return new MistralRequestAdapter(request);
    },

    createResponseAdapter(
        response: Mistral.Types.ChatResponse,
    ): LLMResponseAdapter<Mistral.Types.ChatResponse> {
        return new MistralResponseAdapter(response);
    },

    createStreamAdapter(): LLMStreamAdapter<
        Mistral.Types.StreamChunk,
        Mistral.Types.ChatResponse
    > {
        return new MistralStreamAdapter();
    },

    extractApiKey(headers: Mistral.Types.ChatHeaders): string | undefined {
        return headers.authorization;
    },

    getBaseUrl(): string | undefined {
        return config.llm.mistral?.baseUrl;
    },

    getSpanName(streaming: boolean): string {
        return `mistral.chat${streaming ? ".stream" : ""}`;
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
        request: Mistral.Types.ChatRequest,
    ): Promise<Mistral.Types.ChatResponse> {
        const response = await client.chat(request.model).doChat(request);
        return response.rawResponse as Mistral.Types.ChatResponse;
    },

    async executeStream(
        client: any,
        request: Mistral.Types.ChatRequest,
    ): Promise<AsyncIterable<Mistral.Types.StreamChunk>> {
        const { stream } = await client.chat(request.model).doStream(request);
        return stream as AsyncIterable<Mistral.Types.StreamChunk>;
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
