/**
 * NOTE: this is a bit of a PITA/verbose but in order to properly type everything that we are
 * proxing.. this is kinda necessary.
 *
 * the zhipu ai api doesn't expose a typescript sdk, so we define our own zod schemas..
 */
import type { z } from "zod";
import * as ZhipuaiAPI from "./api";
import * as ZhipuaiMessages from "./messages";
import * as ZhipuaiTools from "./tools";

namespace Zhipuai {
  export const API = ZhipuaiAPI;
  export const Messages = ZhipuaiMessages;
  export const Tools = ZhipuaiTools;

  export namespace Types {
    export type ChatCompletionsHeaders = z.infer<
      typeof ZhipuaiAPI.ChatCompletionsHeadersSchema
    >;
    export type ChatCompletionsRequest = z.infer<
      typeof ZhipuaiAPI.ChatCompletionRequestSchema
    >;
    export type ChatCompletionsResponse = z.infer<
      typeof ZhipuaiAPI.ChatCompletionResponseSchema
    >;
    export type Usage = z.infer<typeof ZhipuaiAPI.ChatCompletionUsageSchema>;

    export type FinishReason = z.infer<typeof ZhipuaiAPI.FinishReasonSchema>;
    export type Message = z.infer<typeof ZhipuaiMessages.MessageParamSchema>;
    export type Role = Message["role"];

    export type ChatCompletionChunk = {
      id: string;
      object: "chat.completion.chunk";
      created: number;
      model: string;
      choices: Array<{
        index: number;
        delta: {
          role?: "assistant";
          content?: string;
          reasoning_content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            type?: "function";
            function?: {
              name?: string;
              arguments?: string;
            };
          }>;
        };
        finish_reason: string | null;
      }>;
      usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
      };
    };
  }
}

export default Zhipuai;
