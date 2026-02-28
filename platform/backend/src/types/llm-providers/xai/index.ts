/**
 * xAI LLM Provider Types - OpenAI-compatible
 *
 * xAI provides an OpenAI-compatible API at https://api.x.ai/v1
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://docs.x.ai/docs/api-reference
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

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Xai;
