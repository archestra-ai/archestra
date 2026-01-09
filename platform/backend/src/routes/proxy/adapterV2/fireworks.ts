import { Fireworks } from "@/types/llm-providers/fireworks";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
} from "./openai";
import type { LLMProvider } from "@/types";

export const fireworksAdapterFactory: LLMProvider<
    Fireworks.Types.ChatRequest,
    Fireworks.Types.ChatResponse,
    any,
    Fireworks.Types.StreamChunk,
    Fireworks.Types.ChatHeaders
> = {
    provider: "fireworks",
    interactionType: "fireworks:chat",
    getBaseUrl: () => "https://api.fireworks.ai/inference/v1",
    getSpanName: (stream) => `fireworks.chat${stream ? ".stream" : ""}`,
    extractApiKey: (headers) => headers.authorization,
    extractErrorMessage: (error) => (error as any)?.message || "Fireworks AI Error",
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
