import { OAUTH_ONLY_CLIENT_IDS } from "@archestra/shared/connection-setup";
import { z } from "zod";
import {
  ConnectionSetupClientIdSchema,
  type ConnectionSetupPlatform,
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

/** One of a member's connected agents, as admins see it under Logs. */
export const MemberConnectedClientSchema = ConnectedClientSchema.extend({
  /** First connect for this client. */
  connectedAt: z.date(),
});

export const MemberConnectionStatusSchema = z.enum([
  "connected",
  "not_connected",
]);
export type MemberConnectionStatus = z.infer<
  typeof MemberConnectionStatusSchema
>;

/**
 * An organization member with the agents they connected through the Connect
 * page; `clients` is empty for members who never connected one.
 */
export const MemberConnectionsSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
  /** Most recent connect across their agents; null when never connected. */
  lastConnectedAt: z.date().nullable(),
  /** Most recently connected first. */
  clients: z.array(MemberConnectedClientSchema),
});
export type MemberConnections = z.infer<typeof MemberConnectionsSchema>;
