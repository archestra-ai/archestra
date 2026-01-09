import { z } from "zod";
import OpenAi from "../openai";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema;
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;
export type ChatHeaders = z.infer<typeof ChatHeadersSchema>;

export type StreamChunk = OpenAi.Types.ChatCompletionChunk;
