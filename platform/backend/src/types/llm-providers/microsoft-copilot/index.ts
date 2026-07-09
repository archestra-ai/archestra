/**
 * Microsoft Copilot LLM Provider Types - OpenAI-compatible inbound
 *
 * The proxy's inbound wire format is OpenAI chat completions; the adapter
 * translates to the Microsoft 365 Copilot Chat API (Graph beta) upstream, so
 * these types re-export the OpenAI schemas with passthrough.
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as MicrosoftCopilotAPI from "./api";
import * as MicrosoftCopilotMessages from "./messages";
import * as MicrosoftCopilotTools from "./tools";

namespace MicrosoftCopilot {
  export const API = MicrosoftCopilotAPI;
  export const Messages = MicrosoftCopilotMessages;
  export const Tools = MicrosoftCopilotTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof MicrosoftCopilotAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof MicrosoftCopilotAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof MicrosoftCopilotAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<
      typeof MicrosoftCopilotAPI.ChatCompletionUsageSchema
    >;

    export type FinishReason = z.infer<
      typeof MicrosoftCopilotAPI.FinishReasonSchema
    >;
    export type Message = z.infer<
      typeof MicrosoftCopilotMessages.MessageParamSchema
    >;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default MicrosoftCopilot;
