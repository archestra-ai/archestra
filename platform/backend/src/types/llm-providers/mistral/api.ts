import { z } from "zod";
import OpenAi from "../openai";
import * as MistralMessages from "./messages";
import * as MistralTools from "./tools";

export const ChatRequestSchema = OpenAi.API.ChatCompletionRequestSchema.extend({
    messages: MistralMessages.ChatMessageListSchema,
    tools: MistralTools.ToolSchema.array().optional(),
    tool_choice: MistralTools.ToolChoiceSchema.optional(),
});

export const ChatResponseSchema = OpenAi.API.ChatCompletionResponseSchema;
export const ChatHeadersSchema = OpenAi.API.ChatCompletionsHeadersSchema;

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
export type ChatResponse = z.infer<typeof ChatResponseSchema>;
export type ChatHeaders = z.infer<typeof ChatHeadersSchema>;

export type StreamChunk = OpenAi.Types.ChatCompletionChunk;
