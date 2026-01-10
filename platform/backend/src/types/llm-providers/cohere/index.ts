/**
 * Cohere LLM Provider Types
 *
 * Type definitions for Cohere V2 Chat API
 * @see https://docs.cohere.com/reference/chat
 */

import type { z } from "zod";
import * as CohereAPI from "./api";
import * as CohereMessages from "./messages";
import type { ModelSchema } from "./models";
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

    export type Tool = z.infer<typeof CohereTools.ToolSchema>;
    export type ToolCall = z.infer<typeof CohereTools.ToolCallSchema>;

    export type Model = z.infer<typeof ModelSchema>;
  }
}

export default Cohere;
