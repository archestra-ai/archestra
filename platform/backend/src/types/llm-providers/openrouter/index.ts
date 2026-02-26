/**
 * OpenRouter LLM Provider Types - OpenAI-compatible
 *
 * OpenRouter uses an OpenAI-compatible API at https://openrouter.ai/api/v1
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://openrouter.ai/docs/api-reference/overview
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OpenrouterAPI from "./api";
import * as OpenrouterMessages from "./messages";
import * as OpenrouterTools from "./tools";

namespace Openrouter {
  export const API = OpenrouterAPI;
  export const Messages = OpenrouterMessages;
  export const Tools = OpenrouterTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenrouterAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenrouterAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenrouterAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenrouterAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenrouterAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenrouterMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Openrouter;
