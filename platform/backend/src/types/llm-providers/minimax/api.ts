import { z } from "zod";
import OpenAi from "../openai";
import * as MiniMaxMessages from "./messages";
import * as MiniMaxTools from "./tools";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema.extend({
    messages: MiniMaxMessages.ChatMessageListSchema,
    tools: MiniMaxTools.ToolSchema.array().optional(),
    tool_choice: MiniMaxTools.ToolChoiceSchema.optional(),
});

export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatHeaders = z.infer<typeof ChatHeadersSchema>;

export type StreamChunk = OpenAi.Types.ChatCompletionChunk;
