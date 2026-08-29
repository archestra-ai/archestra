/**
 * OrcaRouter LLM Provider Types - OpenAI-compatible
 *
 * OrcaRouter uses an OpenAI-compatible API at https://api.orcarouter.ai/v1
 * Full support for tool calling, streaming, and standard chat completions.
 *
 * @see https://www.orcarouter.ai
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as OrcaRouterAPI from "./api";
import * as OrcaRouterMessages from "./messages";
import * as OrcaRouterTools from "./tools";

namespace OrcaRouter {
  export const API = OrcaRouterAPI;
  export const Messages = OrcaRouterMessages;
  export const Tools = OrcaRouterTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof OrcaRouterAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof OrcaRouterAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof OrcaRouterAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof OrcaRouterAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof OrcaRouterAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof OrcaRouterMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default OrcaRouter;
