import { z } from "zod";

/**
 * WebSocket Message Payload Schemas
 */
const HelloWorldWebsocketPayloadSchema = z.object({});

/**
 * Discriminated union of all possible websocket messages
 */
export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["hello-world"]),
    payload: HelloWorldWebsocketPayloadSchema,
  }),
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
