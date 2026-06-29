/**
 * vLLM Type Definitions
 *
 * vLLM is an OpenAI-compatible inference server.
 * See: https://docs.vllm.ai/en/latest/features/openai_api.html
 *
 * NOTE: vLLM types are very similar to OpenAI since vLLM implements the OpenAI API.
 * The main differences are:
 * - vLLM doesn't require API keys (often uses dummy values)
 * - vLLM may have additional model-specific fields like "reasoning"
 * - vLLM has additional parameters like repetition_penalty
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as VllmAPI from "./api";
import * as VllmMessages from "./messages";
import type * as VllmModels from "./models";
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

    // vLLM uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof VllmModels.ModelSchema>;
  }
}

export default Vllm;
