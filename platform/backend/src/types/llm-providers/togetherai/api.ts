import OpenAi from "../openai";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema;
export type ChatRequest = OpenAi.Types.ChatCompletionsRequest;

export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export type ChatResponse = OpenAi.Types.ChatCompletionsResponse;

export type ChatStreamResponse = OpenAi.Types.ChatCompletionChunk;

export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;
export type ChatHeaders = OpenAi.Types.ChatCompletionsHeaders;
