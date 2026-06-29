/**
 * Mistral LLM Provider Types - OpenAI-compatible
 *
 * Mistral uses an OpenAI-compatible API at https://api.mistral.ai/v1
 * We re-export OpenAI schemas with Mistral-specific namespace for type safety.
 *
 * @see https://docs.mistral.ai/api
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MistralAPI from "./api";
import * as MistralMessages from "./messages";
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

    // Use OpenAI's stream chunk type since Mistral is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Mistral;
