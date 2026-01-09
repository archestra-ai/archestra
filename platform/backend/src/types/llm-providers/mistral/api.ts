import { z } from "zod";
import OpenAi from "../openai";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema;
export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;
export const StreamChunkSchema = OpenAi.API.StreamChunkSchema;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatHeaders = z.infer<typeof ChatHeadersSchema>;
export type StreamChunk = z.infer<typeof StreamChunkSchema>;

export namespace Types {
    export type Model = OpenAi.Types.Model;
}
