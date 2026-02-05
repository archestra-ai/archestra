/**
 * Groq LLM Provider types
 *
 * Groq uses an OpenAI-compatible API at api.groq.com/openai/v1
 */
import type { z } from "zod";
import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
import * as GroqTools from "./tools";

namespace Groq {
  export const API = GroqAPI;
  export const Messages = GroqMessages.Messages;
  export const Tools = GroqTools.Tools;

  export namespace Types {
    export type ChatCompletionRequest = z.infer<
      typeof GroqAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionResponse = z.infer<
      typeof GroqAPI.ChatCompletionResponseSchema
    >;
    export type ChatCompletionsHeaders = z.infer<
      typeof GroqAPI.ChatCompletionsHeadersSchema
    >;
  }
}

export default Groq;
