import { z } from "zod";
import * as MistralAPI from "./api";
import * as MistralMessages from "./messages";
import * as MistralTools from "./tools";

namespace Mistral {
    export const API = MistralAPI;
    export const Messages = MistralMessages;
    export const Tools = MistralTools;

    export namespace Types {
        export type ChatRequest = z.infer<typeof MistralAPI.ChatRequestSchema>;
        export type ChatResponse = z.infer<typeof MistralAPI.ChatResponseSchema>;
        export type ChatHeaders = z.infer<typeof MistralAPI.ChatHeadersSchema>;
        export type StreamChunk = z.infer<typeof MistralAPI.StreamChunkSchema>;
        export type Model = MistralAPI.Types.Model;
    }
}

export default Mistral;
