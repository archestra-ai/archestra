/**
 * x.ai Grok LLM Provider Types
 *
 * x.ai's Grok API is OpenAI-compatible, so we can reuse most OpenAI schemas.
 * The main differences are:
 * - Base URL: https://api.x.ai/v1
 * - Model names: grok-beta, grok-2, grok-2-mini, etc.
 */
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
  }
}

export default Xai;
