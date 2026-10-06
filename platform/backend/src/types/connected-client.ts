import { z } from "zod";
import { OAUTH_ONLY_CLIENT_IDS } from "./connected-client-ids";
import {
  ConnectionSetupClientIdSchema,
  ConnectionSetupPlatformSchema,
} from "./connection-setup";

/**
 * Agents that can show as connected: every scriptable setup client, plus
 * agents recognised only from their gateway OAuth sign-in.
 */
export const ConnectedClientIdSchema = z.enum([
  ...ConnectionSetupClientIdSchema.options,
  ...OAUTH_ONLY_CLIENT_IDS,
]);
export type ConnectedClientId = z.infer<typeof ConnectedClientIdSchema>;

/**
 * One coding client the user connected, from their redeemed setup tickets or,
 * for agents set up by hand, their gateway OAuth sign-in (one entry per
 * client, latest connect wins).
 */
export const ConnectedClientSchema = z.object({
  clientId: ConnectedClientIdSchema,
  /** Null when the agent is known only from its OAuth sign-in. */
  platform: ConnectionSetupPlatformSchema.nullable(),
  mcpGatewayId: z.string().uuid().nullable(),
  llmProxyId: z.string().uuid().nullable(),
  /** First redeemed setup for this client. */
  connectedAt: z.date(),
  /** Most recent redeemed setup for this client. */
  lastConnectedAt: z.date(),
  /** Machines the client was connected on, most recent first; empty when unknown. */
  deviceNames: z.array(z.string()),
});
export type ConnectedClient = z.infer<typeof ConnectedClientSchema>;

/**
 * Admin view: one member who connected at least one client, with their
 * recent gateway and LLM proxy use.
 */
export const ConnectedUserSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  clientIds: z.array(ConnectionSetupClientIdSchema),
  firstConnectedAt: z.date(),
  lastConnectedAt: z.date(),
  /** Latest MCP gateway tool call within the usage window, else null. */
  lastGatewayCallAt: z.date().nullable(),
  gatewayCallCount: z.number().int(),
  /** Latest LLM proxy request within the usage window, else null. */
  lastLlmRequestAt: z.date().nullable(),
  llmRequestCount: z.number().int(),
});
export type ConnectedUser = z.infer<typeof ConnectedUserSchema>;
