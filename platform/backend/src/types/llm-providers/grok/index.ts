/**
 * Grok LLM Provider Types - OpenAI-compatible
 * @see https://grok.ai/api
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as GrokAPI from "./api";
import * as GrokMessages from "./messages";
import * as GrokTools from "./tools";

namespace Grok {
  export const API = GrokAPI;
  export const Messages = GrokMessages;
  export const Tools = GrokTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof GrokAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof GrokAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof GrokAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof GrokAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof GrokAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof GrokMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Grok;
