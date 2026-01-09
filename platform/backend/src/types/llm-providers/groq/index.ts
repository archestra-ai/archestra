import { z } from "zod";
import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
import * as GroqTools from "./tools";

namespace Groq {
    export const API = GroqAPI;
    export const Messages = GroqMessages;
    export const Tools = GroqTools;

    export namespace Types {
        export type ChatRequest = z.infer<typeof GroqAPI.ChatRequestSchema>;
        export type ChatResponse = z.infer<typeof GroqAPI.ChatResponseSchema>;
        export type ChatHeaders = z.infer<typeof GroqAPI.ChatHeadersSchema>;
        export type StreamChunk = GroqAPI.StreamChunk;
    }
}

export default Groq;
