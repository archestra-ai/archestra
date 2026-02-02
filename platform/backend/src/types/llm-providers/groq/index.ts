import type { z } from "zod";
import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
import * as GroqTools from "./tools";

namespace Groq {
  export const API = GroqAPI;
  export const Messages = GroqMessages;
  export const Tools = GroqTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof GroqAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof GroqAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof GroqAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof GroqAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof GroqAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof GroqMessages.MessageParamSchema>;
    export type Role = Message["role"];
  }
}

export default Groq;
