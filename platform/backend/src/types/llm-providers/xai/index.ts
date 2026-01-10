/**
 * x.ai (Grok) provider type definitions
 *
 * x.ai uses an OpenAI-compatible API format.
 * Reference: https://docs.x.ai/api
 */
import type { z } from "zod";
import * as XaiAPI from "./api";
import * as XaiMessages from "./messages";
import type * as XaiModels from "./models";
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

    export type ChatCompletionChunk = z.infer<
      typeof XaiAPI.ChatCompletionChunkSchema
    >;
    export type Model = z.infer<typeof XaiModels.ModelSchema>;
  }
}

export default Xai;
