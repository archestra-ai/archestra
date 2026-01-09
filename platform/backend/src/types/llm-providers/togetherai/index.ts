import * as TogetherAIAPI from "./api";
import OpenAi from "../openai";

export namespace TogetherAI {
    export const API = TogetherAIAPI;
    export const Messages = OpenAi.Messages;
    export const Tools = OpenAi.Tools;

    export namespace Types {
        export type ChatRequest = TogetherAIAPI.ChatRequest;
        export type ChatResponse = TogetherAIAPI.ChatResponse;
        export type ChatHeaders = TogetherAIAPI.ChatHeaders;
        export type StreamChunk = TogetherAIAPI.ChatStreamResponse;
    }
}

export default TogetherAI;
