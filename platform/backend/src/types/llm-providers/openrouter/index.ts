/**
 * OpenRouter Type Definitions Namespace
 *
 * Groups all OpenRouter types under OpenRouter.Types for consistent access pattern.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OpenRouterAPI from "./api";
import * as OpenRouterMessages from "./messages";
import * as OpenRouterTools from "./tools";

namespace OpenRouter {
    export const API = OpenRouterAPI;
    export const Messages = OpenRouterMessages;
    export const Tools = OpenRouterTools;

    export namespace Types {
        export type ChatCompletionsHeaders = z.infer<
            typeof OpenRouterAPI.ChatCompletionsHeadersSchema
        >;
        export type ChatCompletionsRequest = z.infer<
            typeof OpenRouterAPI.ChatCompletionRequestSchema
        >;
        export type ChatCompletionsResponse = z.infer<
            typeof OpenRouterAPI.ChatCompletionResponseSchema
        >;
        export type Usage = z.infer<typeof OpenRouterAPI.ChatCompletionUsageSchema>;

        export type FinishReason = z.infer<typeof OpenRouterAPI.FinishReasonSchema>;
        export type Message = z.infer<typeof OpenRouterMessages.MessageParamSchema>;
        export type Role = Message["role"];

        // OpenRouter uses OpenAI-compatible streaming format
        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    }
}

export default OpenRouter;
