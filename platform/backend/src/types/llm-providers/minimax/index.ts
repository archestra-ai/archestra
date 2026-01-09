import * as MiniMaxAPI from "./api";
import * as MiniMaxMessages from "./messages";
import * as MiniMaxTools from "./tools";

export namespace MiniMax {
    export const API = MiniMaxAPI;
    export const Messages = MiniMaxMessages;
    export const Tools = MiniMaxTools;

    export namespace Types {
        export type ChatRequest = MiniMaxAPI.ChatRequest;
        export type ChatResponse = MiniMaxAPI.ChatResponse;
        export type ChatHeaders = MiniMaxAPI.ChatHeaders;
        export type StreamChunk = MiniMaxAPI.StreamChunk;
    }
}

export default MiniMax;

export type StreamChunk = MiniMaxAPI.StreamChunk;
