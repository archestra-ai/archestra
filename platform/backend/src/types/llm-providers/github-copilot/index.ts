/**
 * GitHub Copilot LLM Provider Types - OpenAI-compatible
 *
 * GitHub Copilot serves an OpenAI-compatible chat completions API at
 * https://api.githubcopilot.com. We re-export OpenAI schemas with passthrough
 * for Copilot-specific fields; stream chunk type uses OpenAI SDK.
 */
import type OpenAIProvider from "openai";
import type {
  Response,
  ResponseCreateParams,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import type { z } from "zod";
import * as GithubCopilotAPI from "./api";
import * as GithubCopilotMessages from "./messages";
import * as GithubCopilotTools from "./tools";

namespace GithubCopilot {
  export const API = GithubCopilotAPI;
  export const Messages = GithubCopilotMessages;
  export const Tools = GithubCopilotTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof GithubCopilotAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof GithubCopilotAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof GithubCopilotAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<
      typeof GithubCopilotAPI.ChatCompletionUsageSchema
    >;

    export type FinishReason = z.infer<
      typeof GithubCopilotAPI.FinishReasonSchema
    >;
    export type Message = z.infer<
      typeof GithubCopilotMessages.MessageParamSchema
    >;
    export type Role = Message["role"];

    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;

    // The Responses surface, typed off the OpenAI Responses SDK types it is
    // wire-compatible with. This is where Copilot's Codex and GPT-5.x models
    // live — they are not reachable via chat completions.
    export type ResponsesHeaders = z.infer<
      typeof GithubCopilotAPI.ResponsesHeadersSchema
    >;
    export type ResponsesRequest = ResponseCreateParams & { model: string };
    export type ResponsesResponse = Response;
    export type ResponsesUsage = z.infer<
      typeof GithubCopilotAPI.ResponsesUsageSchema
    >;
    export type ResponseChunk = ResponseStreamEvent;
  }
}

export default GithubCopilot;
