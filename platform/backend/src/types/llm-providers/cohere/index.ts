/**
 * Cohere v2 Chat API type definitions
 * Based on https://docs.cohere.com/reference/chat
 */

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
    export type ChatStreamEvent = z.infer<
      typeof CohereAPI.ChatStreamEventSchema
    >;
    export type Usage = z.infer<typeof CohereAPI.UsageSchema>;

    export type Tool = z.infer<typeof CohereTools.ToolSchema>;
  }
}

export default Cohere;
