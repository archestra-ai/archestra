import { z } from "zod";
import { OpenAiChatCompletionsRequestSchema, OpenAiChatCompletionsResponseSchema, OpenAiChatCompletionChunkSchema, OpenAiChatCompletionsHeadersSchema } from "../openai/api";

export namespace Mistral {
  export namespace Types {
    export const ChatCompletionsRequestSchema = OpenAiChatCompletionsRequestSchema;
    export type ChatCompletionsRequest = z.infer<typeof ChatCompletionsRequestSchema>;

    export const ChatCompletionsResponseSchema = OpenAiChatCompletionsResponseSchema;
    export type ChatCompletionsResponse = z.infer<typeof ChatCompletionsResponseSchema>;

    export const ChatCompletionChunkSchema = OpenAiChatCompletionChunkSchema;
    export type ChatCompletionChunk = z.infer<typeof ChatCompletionChunkSchema>;

    export const ChatCompletionsHeadersSchema = OpenAiChatCompletionsHeadersSchema;
    export type ChatCompletionsHeaders = z.infer<typeof ChatCompletionsHeadersSchema>;
  }
}
