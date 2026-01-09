/**
 * x.ai (Grok) LLM Provider Types
 *
 * x.ai provides an OpenAI-compatible API at https://api.x.ai/v1
 * This module mirrors OpenAI types for full compatibility while
 * maintaining separation for potential future x.ai-specific features.
 *
 * Supported models: grok-4, grok-4-1-fast-reasoning, grok-4-1-fast-non-reasoning, grok-code-fast-1
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as XaiAPI from "./api";
import * as XaiMessages from "./messages";
import * as XaiTools from "./tools";

namespace Xai {
    export const API = XaiAPI;
    export const Messages = XaiMessages;
    export const Tools = XaiTools;

    export namespace Types {
        export type ChatCompletionsHeaders = z.infer<
            typeof XaiAPI.ChatCompletionsHeadersSchema
        >;
        export type ChatCompletionsRequest = z.infer<
            typeof XaiAPI.ChatCompletionRequestSchema
        >;
        export type ChatCompletionsResponse = z.infer<
            typeof XaiAPI.ChatCompletionResponseSchema
        >;
        export type Usage = z.infer<typeof XaiAPI.ChatCompletionUsageSchema>;
        export type FinishReason = z.infer<typeof XaiAPI.FinishReasonSchema>;
        export type Message = z.infer<typeof XaiMessages.MessageParamSchema>;
        export type Role = Message["role"];

        // Re-use OpenAI's streaming chunk type
        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    }
}

export default Xai;
