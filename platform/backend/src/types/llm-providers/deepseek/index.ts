import { z } from "zod";
import * as DeepSeekAPI from "./api";
import * as DeepSeekMessages from "./messages";
import * as DeepSeekTools from "./tools";

namespace DeepSeek {
    export const API = DeepSeekAPI;
    export const Messages = DeepSeekMessages;
    export const Tools = DeepSeekTools;

    export namespace Types {
        export type ChatRequest = z.infer<typeof DeepSeekAPI.ChatRequestSchema>;
        export type ChatResponse = z.infer<typeof DeepSeekAPI.ChatResponseSchema>;
        export type ChatHeaders = z.infer<typeof DeepSeekAPI.ChatHeadersSchema>;
        export type StreamChunk = z.infer<typeof DeepSeekAPI.StreamChunkSchema>;
        export type Model = DeepSeekAPI.Types.Model;
    }
}

export default DeepSeek;
