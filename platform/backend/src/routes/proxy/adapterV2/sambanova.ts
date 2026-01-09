import { SambaNova } from "@/types/llm-providers/sambanova";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
} from "./openai";
import type { LLMProvider } from "@/types";

export const sambanovaAdapterFactory: LLMProvider<
    SambaNova.Types.ChatRequest,
    SambaNova.Types.ChatResponse,
    any,
    SambaNova.Types.StreamChunk,
    SambaNova.Types.ChatHeaders
> = {
    provider: "sambanova",
    interactionType: "sambanova:chat",
    getBaseUrl: () => "https://api.sambanova.ai/v1",
    getSpanName: (stream) => `sambanova.chat${stream ? ".stream" : ""}`,
    extractApiKey: (headers) => headers.authorization,
    extractErrorMessage: (error) => (error as any)?.message || "SambaNova Error",
    execute: async (client, body) => (client as any).chat.completions.create(body),
    executeStream: async (client, body) => (client as any).chat.completions.create({ ...body, stream: true }),
    createClient: (apiKey, options) => {
        const { OpenAI } = require("openai");
        return new OpenAI({
            apiKey,
            baseURL: options?.baseUrl,
            defaultHeaders: options?.defaultHeaders,
        });
    },
    createRequestAdapter: (body) => new OpenAIRequestAdapter(body),
    createResponseAdapter: (response) => new OpenAIResponseAdapter(response),
    createStreamAdapter: () => new OpenAIStreamAdapter(),
};
