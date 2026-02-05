/**
 * DeepSeek LLM Provider types
 *
 * DeepSeek uses an OpenAI-compatible API at api.deepseek.com
 */
import type { z } from "zod";
import * as DeepSeekAPI from "./api";
import * as DeepSeekMessages from "./messages";
import * as DeepSeekTools from "./tools";

namespace DeepSeek {
  export const API = DeepSeekAPI;
  export const Messages = DeepSeekMessages.Messages;
  export const Tools = DeepSeekTools.Tools;

  export namespace Types {
    export type ChatCompletionRequest = z.infer<
      typeof DeepSeekAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionResponse = z.infer<
      typeof DeepSeekAPI.ChatCompletionResponseSchema
    >;
    export type ChatCompletionsHeaders = z.infer<
      typeof DeepSeekAPI.ChatCompletionsHeadersSchema
    >;
  }
}

export default DeepSeek;
