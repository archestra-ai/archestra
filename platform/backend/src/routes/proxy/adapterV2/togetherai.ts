import { TogetherAI } from "@/types/llm-providers/togetherai";
import {
    OpenAIRequestAdapter,
    OpenAIResponseAdapter,
    OpenAIStreamAdapter,
} from "./openai";
import type { LLMProvider } from "@/types";

export const togetheraiAdapterFactory: LLMProvider<
    TogetherAI.Types.ChatRequest,
    TogetherAI.Types.ChatResponse,
    any,
    TogetherAI.Types.StreamChunk,
    TogetherAI.Types.ChatHeaders
> = {
    provider: "togetherai",
    interactionType: "togetherai:chat",
    getBaseUrl: () => "https://api.together.xyz/v1",
    getSpanName: (stream) => `togetherai.chat${stream ? ".stream" : ""}`,
    extractApiKey: (headers) => headers.authorization,
    extractErrorMessage: (error) => (error as any)?.message || "Together AI Error",
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
