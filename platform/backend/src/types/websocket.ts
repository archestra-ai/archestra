import { z } from "zod";

/**
 * WebSocket Message Payload Schemas
 */
const McpInstallationRequestWebsocketPayloadSchema = z.object({});

/**
 * Discriminated union of all possible websocket messages
 */
export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.enum(["mcp-installation-request"]),
    payload: McpInstallationRequestWebsocketPayloadSchema,
  }),
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
