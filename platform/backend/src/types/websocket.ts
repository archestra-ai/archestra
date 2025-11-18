import { z } from "zod";

/**
 * WebSocket Message Payload Schemas
 */
export const McpInstallationRequestWebsocketPayloadSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string(),
  externalCatalogId: z.string().optional(),
  requestReason: z.string().optional(),
  customServerConfig: z.record(z.string(), z.any()).optional(),
});

export const McpInstallationResponseWebsocketPayloadSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string(),
  success: z.boolean(),
  message: z.string().optional(),
});

/**
 * Discriminated union of all possible websocket messages
 */
export const WebSocketMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("mcp-installation-request"),
    payload: McpInstallationRequestWebsocketPayloadSchema,
  }),
  z.object({
    type: z.literal("mcp-installation-response"),
    payload: McpInstallationResponseWebsocketPayloadSchema,
  }),
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
export type McpInstallationRequestWebsocketPayload = z.infer<
  typeof McpInstallationRequestWebsocketPayloadSchema
>;
export type McpInstallationResponseWebsocketPayload = z.infer<
  typeof McpInstallationResponseWebsocketPayloadSchema
>;

/**
 * Register schemas in global registry for OpenAPI generation
 */
z.globalRegistry.add(WebSocketMessageSchema, {
  id: "WebSocketMessage",
});
