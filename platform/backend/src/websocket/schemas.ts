import { z } from "zod";

/**
 * WebSocket Message Payload Schemas
 */

export const McpInstallationRequestPayloadSchema = z.object({
  sessionId: z.string(),
  conversationId: z.string(),
  externalCatalogId: z.string().optional(),
  requestReason: z.string().optional(),
  customServerConfig: z.record(z.string(), z.any()).optional(),
});

export const McpInstallationResponsePayloadSchema = z.object({
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
    payload: McpInstallationRequestPayloadSchema,
  }),
  z.object({
    type: z.literal("mcp-installation-response"),
    payload: McpInstallationResponsePayloadSchema,
  }),
]);

export type WebSocketMessage = z.infer<typeof WebSocketMessageSchema>;
export type McpInstallationRequestPayload = z.infer<
  typeof McpInstallationRequestPayloadSchema
>;
export type McpInstallationResponsePayload = z.infer<
  typeof McpInstallationResponsePayloadSchema
>;

/**
 * Register schemas in global registry for OpenAPI generation
 */
z.globalRegistry.add(McpInstallationRequestPayloadSchema, {
  id: "McpInstallationRequest",
});
z.globalRegistry.add(McpInstallationResponsePayloadSchema, {
  id: "McpInstallationResponse",
});
z.globalRegistry.add(WebSocketMessageSchema, {
  id: "WebSocketMessage",
});
