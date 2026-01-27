import type { z } from "zod";
import * as CohereAPI from "./api";
import * as CohereMessages from "./messages";
import * as CohereTools from "./tools";

namespace Cohere {
  export const API = CohereAPI;
  export const Messages = CohereMessages;
  export const Tools = CohereTools;

  export namespace Types {
    export type ChatHeaders = z.infer<typeof CohereAPI.ChatHeadersSchema>;
    export type ChatRequest = z.infer<typeof CohereAPI.ChatRequestSchema>;
    export type ChatResponse = z.infer<typeof CohereAPI.ChatResponseSchema>;
    export type Usage = z.infer<typeof CohereAPI.UsageSchema>;

    export type Tool = z.infer<typeof CohereTools.CohereToolSchema>;
    export type ToolCall = z.infer<typeof CohereMessages.CohereToolCallSchema>;

    export type Message = z.infer<
      typeof CohereMessages.CohereMessageParamSchema
    >;
    export type UserMessage = z.infer<
      typeof CohereMessages.CohereUserMessageSchema
    >;
    export type AssistantMessage = z.infer<
      typeof CohereMessages.CohereAssistantMessageSchema
    >;
    export type SystemMessage = z.infer<
      typeof CohereMessages.CohereSystemMessageSchema
    >;
    export type ToolMessage = z.infer<
      typeof CohereMessages.CohereToolMessageSchema
    >;
  }
}

export default Cohere;
