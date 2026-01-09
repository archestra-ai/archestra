/**
 * Ollama Provider Types
 *
 * Ollama provides an OpenAI-compatible API at /v1/chat/completions,
 * so most types are re-exported from OpenAI for maximum compatibility.
 *
 * Default endpoint: http://localhost:11434/v1
 */
import type OpenAIProvider from "openai";
import { z } from "zod";
import * as OllamaAPI from "./api";
import * as OllamaMessages from "./messages";
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

        // Re-use OpenAI's streaming chunk type for Ollama compatibility
        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    }
}

export { Ollama };
