/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the openai ts sdk doesn't expose zod schemas for all of this..
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OpenAiAPI from "./api";
import * as OpenAiMessages from "./messages";
import type * as OpenAiModels from "./models";
import * as OpenAiTools from "./tools";

namespace OpenAi {
  export const API = OpenAiAPI;
  export const Messages = OpenAiMessages;
  export const Tools = OpenAiTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OpenAiAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OpenAiAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OpenAiAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OpenAiAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OpenAiAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OpenAiMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof OpenAiModels.ModelSchema>;
    export type OrlandoModel = z.infer<typeof OpenAiModels.OrlandoModelSchema>;
  }
}

export default OpenAi;
