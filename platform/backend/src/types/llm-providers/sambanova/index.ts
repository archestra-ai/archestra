import * as SambaNovaAPI from "./api";
import OpenAi from "../openai";

export namespace SambaNova {
    export const API = SambaNovaAPI;
    export const Messages = OpenAi.Messages;
    export const Tools = OpenAi.Tools;

    export namespace Types {
        export type ChatRequest = SambaNovaAPI.ChatRequest;
        export type ChatResponse = SambaNovaAPI.ChatResponse;
        export type ChatHeaders = SambaNovaAPI.ChatHeaders;
        export type StreamChunk = SambaNovaAPI.ChatStreamResponse;
    }
}

export default SambaNova;
