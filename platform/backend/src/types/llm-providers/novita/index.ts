import * as NovitaAPI from "./api";
import OpenAi from "../openai";

export namespace Novita {
    export const API = NovitaAPI;
    export const Messages = OpenAi.Messages;
    export const Tools = OpenAi.Tools;

    export namespace Types {
        export type ChatRequest = NovitaAPI.ChatRequest;
        export type ChatResponse = NovitaAPI.ChatResponse;
        export type ChatHeaders = NovitaAPI.ChatHeaders;
        export type StreamChunk = NovitaAPI.ChatStreamResponse;
    }
}

export default Novita;
