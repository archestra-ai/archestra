/**
 * Cerebras LLM Provider Types - OpenAI-compatible
 *
 * Cerebras uses an OpenAI-compatible API at https://api.cerebras.ai/v1
 * We re-export OpenAI schemas with Cerebras-specific namespace for type safety.
 *
 * @see https://inference-docs.cerebras.ai/
 */
import type OpenAIProvider from "openai";
import type { z } from "zod";
import * as CerebrasAPI from "./api";
import * as CerebrasMessages from "./messages";
import * as CerebrasTools from "./tools";

namespace Cerebras {
  export const API = CerebrasAPI;
  export const Messages = CerebrasMessages;
  export const Tools = CerebrasTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof CerebrasAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof CerebrasAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof CerebrasAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof CerebrasAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof CerebrasAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof CerebrasMessages.MessageParamSchema>;
    export type Role = Message["role"];

    // Use OpenAI's stream chunk type since Cerebras is OpenAI-compatible
    export type ChatCompletionChunk =
      OpenAIProvider.Chat.Completions.ChatCompletionChunk;
  }
}

export default Cerebras;
