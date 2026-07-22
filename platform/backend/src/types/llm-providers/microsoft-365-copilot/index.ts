/**
 * Microsoft 365 Copilot LLM Provider Types - OpenAI-compatible inbound
 *
 * The proxy's inbound wire format is OpenAI chat completions; the adapter
 * translates to the Microsoft 365 Copilot Chat API (Graph beta) upstream, so
 * these types re-export the OpenAI schemas with passthrough.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as Microsoft365CopilotAPI from "./api";
import * as Microsoft365CopilotMessages from "./messages";
import * as Microsoft365CopilotTools from "./tools";

namespace Microsoft365Copilot {
  export const API = Microsoft365CopilotAPI;
  export const Messages = Microsoft365CopilotMessages;
  export const Tools = Microsoft365CopilotTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof Microsoft365CopilotAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof Microsoft365CopilotAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof Microsoft365CopilotAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<
      typeof Microsoft365CopilotAPI.ChatCompletionUsageSchema
    >;

    export type FinishReason = z.infer<
      typeof Microsoft365CopilotAPI.FinishReasonSchema
    >;
    export type Message = z.infer<
      typeof Microsoft365CopilotMessages.MessageParamSchema
    >;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Microsoft365Copilot;
