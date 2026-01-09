import type { z } from "zod";
import * as CohereAPI from "./api";
import * as CohereMessages from "./messages";
import * as CohereTools from "./tools";

namespace Cohere {
    export const API = CohereAPI;
    export const Messages = CohereMessages;
    export const Tools = CohereTools;

    export namespace Types {
        export type ChatRequest = z.infer<typeof CohereAPI.ChatRequestSchema>;
        export type ChatResponse = z.infer<typeof CohereAPI.ChatResponseSchema>;
        export type ChatHeaders = z.infer<typeof CohereAPI.ChatHeadersSchema>;
        export type StreamChunk = z.infer<typeof CohereAPI.StreamChunkSchema>;
        export type Usage = z.infer<typeof CohereAPI.UsageSchema>;
        export type ChatMessage = CohereMessages.ChatMessage;
        export type Tool = CohereTools.CohereTool;
    }
}

export default Cohere;
