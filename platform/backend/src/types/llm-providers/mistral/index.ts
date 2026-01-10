/**
 * Mistral AI API types for chat completions.
 * Mistral uses an OpenAI-compatible API format at https://api.mistral.ai/v1
 * @see https://docs.mistral.ai/api/
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MistralAPI from "./api";
import * as MistralMessages from "./messages";
import type * as MistralModels from "./models";
import * as MistralTools from "./tools";

namespace Mistral {
  export const API = MistralAPI;
  export const Messages = MistralMessages;
  export const Tools = MistralTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof MistralAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof MistralAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof MistralAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof MistralAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof MistralAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof MistralMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Mistral uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof MistralModels.ModelSchema>;
  }
}

export default Mistral;
