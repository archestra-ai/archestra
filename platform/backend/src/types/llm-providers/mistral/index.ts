import * as MistralAPI from "./api";
import * as MistralMessages from "./messages";
import * as MistralTools from "./tools";

export namespace Mistral {
    export const API = MistralAPI;
    export const Messages = MistralMessages;
    export const Tools = MistralTools;

    export namespace Types {
        export type ChatRequest = MistralAPI.ChatRequest;
        export type ChatResponse = MistralAPI.ChatResponse;
        export type ChatHeaders = MistralAPI.ChatHeaders;
        export type StreamChunk = MistralAPI.StreamChunk;
    }
}

export default Mistral;

export type StreamChunk = MistralAPI.StreamChunk;
