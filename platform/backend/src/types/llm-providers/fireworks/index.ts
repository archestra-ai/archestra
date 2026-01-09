import * as FireworksAPI from "./api";
import OpenAi from "../openai";

export namespace Fireworks {
    export const API = FireworksAPI;
    export const Messages = OpenAi.Messages;
    export const Tools = OpenAi.Tools;

    export namespace Types {
        export type ChatRequest = FireworksAPI.ChatRequest;
        export type ChatResponse = FireworksAPI.ChatResponse;
        export type ChatHeaders = FireworksAPI.ChatHeaders;
        export type StreamChunk = FireworksAPI.ChatStreamResponse;
    }
}

export default Fireworks;
