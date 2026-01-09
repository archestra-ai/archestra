import * as DeepSeekAPI from "./api";
import * as DeepSeekMessages from "./messages";
import * as DeepSeekTools from "./tools";

export namespace DeepSeek {
    export const API = DeepSeekAPI;
    export const Messages = DeepSeekMessages;
    export const Tools = DeepSeekTools;

    export namespace Types {
        export type ChatRequest = DeepSeekAPI.ChatRequest;
        export type ChatResponse = DeepSeekAPI.ChatResponse;
        export type ChatHeaders = DeepSeekAPI.ChatHeaders;
        export type StreamChunk = DeepSeekAPI.StreamChunk;
    }
}

export default DeepSeek;

export type StreamChunk = DeepSeekAPI.StreamChunk;
