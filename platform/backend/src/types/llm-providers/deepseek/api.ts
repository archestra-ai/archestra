import { OpenAi } from "..";

export type ChatRequest = OpenAi.API.ChatRequest;
export const ChatRequestSchema = OpenAi.API.ChatRequestSchema;

export type ChatResponse = OpenAi.API.ChatResponse;
export const ChatResponseSchema = OpenAi.API.ChatResponseSchema;

export type ChatHeaders = OpenAi.API.ChatHeaders;
export const ChatHeadersSchema = OpenAi.API.ChatHeadersSchema;

export type StreamChunk = OpenAi.API.StreamChunk;
export const StreamChunkSchema = OpenAi.API.StreamChunkSchema;

export namespace Types {
    export type Model = OpenAi.API.Types.Model;
}
