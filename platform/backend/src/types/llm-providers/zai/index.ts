/**
 * Z.ai (Zhipu AI) Type Exports
 *
 * Z.ai provides an OpenAI-compatible API format.
 * @see https://docs.z.ai/api-reference/llm/chat-completion
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as ZaiAPI from "./api";
import * as ZaiMessages from "./messages";
import type * as ZaiModels from "./models";
import * as ZaiTools from "./tools";

namespace Zai {
  export const API = ZaiAPI;
  export const Messages = ZaiMessages;
  export const Tools = ZaiTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof ZaiAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof ZaiAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof ZaiAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof ZaiAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof ZaiAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof ZaiMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Z.ai uses OpenAI-compatible streaming chunks
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof ZaiModels.ModelSchema>;
    export type ZaiModel = z.infer<typeof ZaiModels.ZaiModelSchema>;
  }
}

export default Zai;
