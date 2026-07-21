/**
 * Ollama native (`/api/chat`) type definitions.
 *
 * The `ollama-native` provider talks to Ollama's first-class `/api/chat`
 * endpoint (native wire), so — unlike the OpenAI-compatible `../ollama/` types —
 * these schemas describe Ollama's own request/response shapes. This is what lets
 * Archestra send and display `num_ctx`, `num_predict`, `top_k`, `think`, etc.
 */
import type { z } from "zod";
import * as OllamaNativeAPI from "./api";
import * as OllamaNativeMessages from "./messages";
import * as OllamaNativeTools from "./tools";

namespace OllamaNative {
  export const API = OllamaNativeAPI;
  export const Messages = OllamaNativeMessages;
  export const Tools = OllamaNativeTools;

  export namespace Types {
    export type ChatHeaders = z.infer<typeof OllamaNativeAPI.ChatHeadersSchema>;
    export type ChatRequest = z.infer<typeof OllamaNativeAPI.ChatRequestSchema>;
    export type ChatResponse = z.infer<
      typeof OllamaNativeAPI.ChatResponseSchema
    >;
    /**
     * A streaming NDJSON line has the same shape as the final response (`done`
     * false with `message.content`/`message.thinking` deltas, until the final
     * `done: true` line carrying metrics), so it reuses ChatResponseSchema.
     */
    export type ChatStreamChunk = z.infer<
      typeof OllamaNativeAPI.ChatResponseSchema
    >;
    export type Options = z.infer<typeof OllamaNativeAPI.OptionsSchema>;
    export type Think = z.infer<typeof OllamaNativeAPI.ThinkSchema>;
    export type Message = z.infer<typeof OllamaNativeMessages.MessageSchema>;
    export type Messages = ChatRequest["messages"];
    export type ToolCall = z.infer<typeof OllamaNativeMessages.ToolCallSchema>;
  }
}

export default OllamaNative;
