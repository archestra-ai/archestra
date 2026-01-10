import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OllamaAPI from "./api";
import * as OllamaMessages from "./messages";
import * as OllamaModels from "./models";
import * as OllamaTools from "./tools";

namespace Ollama {
    export const API = OllamaAPI;
    export const Messages = OllamaMessages;
    export const Tools = OllamaTools;

    export namespace Types {
        export type ChatCompletionsHeaders = z.infer<
            typeof OllamaAPI.ChatCompletionsHeadersSchema
        >;
        export type ChatCompletionsRequest = z.infer<
            typeof OllamaAPI.ChatCompletionRequestSchema
        >;
        export type ChatCompletionsResponse = z.infer<
            typeof OllamaAPI.ChatCompletionResponseSchema
        >;
        export type Usage = z.infer<typeof OllamaAPI.ChatCompletionUsageSchema>;

        export type FinishReason = z.infer<typeof OllamaAPI.FinishReasonSchema>;
        export type Message = z.infer<typeof OllamaMessages.MessageParamSchema>;
        export type Role = Message["role"];

        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
        export type Model = z.infer<typeof OllamaModels.ModelSchema>;
        export type OrlandoModel = z.infer<typeof OllamaModels.OrlandoModelSchema>;
    }
}

export default Ollama;
