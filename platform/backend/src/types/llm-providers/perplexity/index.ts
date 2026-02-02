import type { z } from "zod";
import * as PerplexityAPI from "./api";
import * as PerplexityMessages from "./messages";
import * as PerplexityTools from "./tools";

namespace Perplexity {
  export const API = PerplexityAPI;
  export const Messages = PerplexityMessages;
  export const Tools = PerplexityTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof PerplexityAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof PerplexityAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof PerplexityAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof PerplexityAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof PerplexityAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof PerplexityMessages.MessageParamSchema>;
    export type Role = Message["role"];
  }
}

export default Perplexity;
