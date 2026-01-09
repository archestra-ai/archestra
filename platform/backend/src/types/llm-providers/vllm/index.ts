/**
 * vLLM LLM Provider Types
 *
 * vLLM provides an OpenAI-compatible API at a configurable base URL
 * (default: http://localhost:8000/v1). This module mirrors OpenAI types
 * for full compatibility while maintaining separation for potential
 * vLLM-specific features.
 *
 * vLLM is a high-throughput and memory-efficient inference and serving
 * engine for LLMs, commonly used for self-hosted models.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as VllmAPI from "./api";
import * as VllmMessages from "./messages";
import * as VllmTools from "./tools";

namespace Vllm {
    export const API = VllmAPI;
    export const Messages = VllmMessages;
    export const Tools = VllmTools;

    export namespace Types {
        export type ChatCompletionsHeaders = z.infer<
            typeof VllmAPI.ChatCompletionsHeadersSchema
        >;
        export type ChatCompletionsRequest = z.infer<
            typeof VllmAPI.ChatCompletionRequestSchema
        >;
        export type ChatCompletionsResponse = z.infer<
            typeof VllmAPI.ChatCompletionResponseSchema
        >;
        export type Usage = z.infer<typeof VllmAPI.ChatCompletionUsageSchema>;
        export type FinishReason = z.infer<typeof VllmAPI.FinishReasonSchema>;
        export type Message = z.infer<typeof VllmMessages.MessageParamSchema>;
        export type Role = Message["role"];

        // Re-use OpenAI's streaming chunk type
        export type ChatCompletionChunk =
            OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    }
}

export default Vllm;
