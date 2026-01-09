import { Novita } from "@/types/llm-providers/novita";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
} from "./openai";
import type { LLMProvider } from "@/types";

export const novitaAdapterFactory: LLMProvider<
    Novita.Types.ChatRequest,
    Novita.Types.ChatResponse,
    any,
    Novita.Types.StreamChunk,
    Novita.Types.ChatHeaders
> = {
    provider: "novita",
    interactionType: "novita:chat",
    getBaseUrl: () => "https://api.novita.ai/v3",
    getSpanName: (stream) => `novita.chat${stream ? ".stream" : ""}`,
    extractApiKey: (headers) => headers.authorization,
    extractErrorMessage: (error) => (error as any)?.message || "Novita Error",
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
