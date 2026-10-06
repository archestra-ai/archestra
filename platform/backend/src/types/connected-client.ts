import { OAUTH_ONLY_CLIENT_IDS } from "@archestra/shared/connection-setup";
import { z } from "zod";
import {
  ConnectionSetupClientIdSchema,
  type ConnectionSetupPlatform,
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
 * client). What the Connect page reads.
 */
export const ConnectedClientSchema = z.object({
  clientId: ConnectedClientIdSchema,
  /** Most recent connect for this client. */
  lastConnectedAt: z.date(),
  /** Machines the client was connected on, most recent first; empty when unknown. */
  deviceNames: z.array(z.string()),
});
export type ConnectedClient = z.infer<typeof ConnectedClientSchema>;

/** A connected client with the setup details the audit log keeps. */
export interface ConnectedClientRecord extends ConnectedClient {
  /** Null when the agent is known only from its OAuth sign-in. */
  platform: ConnectionSetupPlatform | null;
  mcpGatewayId: string | null;
  llmProxyId: string | null;
  /** First connect for this client. */
  connectedAt: Date;
}

/** One redeemed Connect page setup: a user connected an agent on a machine. */
export const ConnectionLogEntrySchema = z.object({
  id: z.string(),
  /** When the installer redeemed the setup. */
  connectedAt: z.date(),
  userId: z.string(),
  userName: z.string(),
  userEmail: z.string(),
  clientId: ConnectionSetupClientIdSchema,
  platform: ConnectionSetupPlatformSchema,
  /** Hostname the installer reported; null for installers that predate it. */
  deviceName: z.string().nullable(),
  /** Gateway the agent got tools from; null when tools were left out. */
  mcpGateway: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Whether model calls were routed through the LLM proxy. */
  modelRouting: z.boolean(),
  includeSkills: z.boolean(),
  /** Set once this agent was disconnected. */
  disconnectedAt: z.date().nullable(),
});
export type ConnectionLogEntry = z.infer<typeof ConnectionLogEntrySchema>;
