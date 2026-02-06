/**
 * x.AI Type Definitions
 *
 * x.AI is an OpenAI-compatible inference server.
 * See: https://docs.xai.ai/en/latest/features/openai_api.html
 *
 * NOTE: x.AI types are very similar to OpenAI since x.AI implements the OpenAI API.
 * The main differences are:
 * - x.AI doesn't require API keys (often uses dummy values)
 * - x.AI may have additional model-specific fields like "reasoning"
 * - x.AI has additional parameters like repetition_penalty
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as XaiAPI from "./api";
import * as XaiMessages from "./messages";
import type * as XaiModels from "./models";
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

    // x.AI uses OpenAI-compatible streaming format
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
    export type Model = z.infer<typeof XaiModels.ModelSchema>;
  }
}

export default Xai;
