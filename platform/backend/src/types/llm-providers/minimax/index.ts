/**
 * MiniMax Provider Types
 *
 * NOTE: MiniMax uses an OpenAI-compatible API.
 * These types shadow the OpenAI structure but are namespaced for MiniMax to allow future divergence.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MiniMaxAPI from "./api";
import * as MiniMaxMessages from "./messages";
import * as MiniMaxTools from "./tools";

namespace MiniMax {
    export const API = MiniMaxAPI;
    export const Messages = MiniMaxMessages;
    export const Tools = MiniMaxTools;

    export namespace Types {
        export type ChatCompletionsHeaders = z.infer<
            typeof MiniMaxAPI.ChatCompletionsHeadersSchema
        >;
        export type ChatCompletionsRequest = z.infer<
            typeof MiniMaxAPI.ChatCompletionRequestSchema
        >;
        export type ChatCompletionsResponse = z.infer<
            typeof MiniMaxAPI.ChatCompletionResponseSchema
        >;
        export type Usage = z.infer<typeof MiniMaxAPI.ChatCompletionUsageSchema>;

        export type FinishReason = z.infer<typeof MiniMaxAPI.FinishReasonSchema>;
        export type Message = z.infer<typeof MiniMaxMessages.MessageParamSchema>;
        export type Role = Message["role"];

        // MiniMax claims OpenAI compatibility, so we can reuse OpenAI's chunk type for now
        // or define a compatible one if we strictly want to decouple.
        // For now, reusing OpenAIProvider.Chat.Completions.ChatCompletionChunk is practical
        // as the underlying client might be the OpenAI SDK configured with a different base URL.
        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    }
}

export default MiniMax;
