import { z } from "zod";
import OpenAi from "../openai";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema;
export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;

// DeepSeek uses OpenAI-compatible streaming format
export type StreamChunk = OpenAi.Types.ChatCompletionChunk;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatHeaders = z.infer<typeof ChatHeadersSchema>;

export namespace Types {
    export type Model = OpenAi.Types.Model;
}
