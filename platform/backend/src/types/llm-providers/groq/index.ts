import * as GroqAPI from "./api";
import * as GroqMessages from "./messages";
import * as GroqTools from "./tools";

export namespace Groq {
    export const API = GroqAPI;
    export const Messages = GroqMessages;
    export const Tools = GroqTools;

    export namespace Types {
        export type ChatRequest = GroqAPI.ChatRequest;
        export type ChatResponse = GroqAPI.ChatResponse;
        export type ChatHeaders = GroqAPI.ChatHeaders;
        export type StreamChunk = GroqAPI.StreamChunk;
    }
}

export default Groq;

export type StreamChunk = GroqAPI.StreamChunk;
