/**
 * Archestra LLM Provider Types - OpenAI-compatible
 *
 * The "archestra" provider lets one Archestra instance use another Archestra's
 * LLM proxy as an upstream provider. That proxy exposes an OpenAI-compatible
 * chat-completions API, so we re-export OpenAI schemas with passthrough; the
 * stream chunk type uses the OpenAI SDK.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as ArchestraAPI from "./api";
import * as ArchestraMessages from "./messages";
import * as ArchestraTools from "./tools";

namespace Archestra {
  export const API = ArchestraAPI;
  export const Messages = ArchestraMessages;
  export const Tools = ArchestraTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof ArchestraAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof ArchestraAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof ArchestraAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof ArchestraAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof ArchestraAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof ArchestraMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Archestra;
