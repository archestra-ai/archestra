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
  /**
   * Newest MCP gateway or LLM proxy call from this agent in the last 30 days;
   * null when none was seen, e.g. a setup that never ran or was removed.
   */
  lastSeenAt: z.date().nullable(),
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

export const ConnectionEventActionSchema = z.enum([
  "connected",
  "disconnected",
]);
export type ConnectionEventAction = z.infer<typeof ConnectionEventActionSchema>;

/**
 * One entry of the organization's agent connection log: a member connected an
 * agent through the Connect page, or that agent was disconnected.
 */
export const ConnectionEventSchema = z.object({
  id: z.string(),
  action: ConnectionEventActionSchema,
  occurredAt: z.date(),
  userId: z.string(),
  userName: z.string(),
  userEmail: z.string(),
  /**
   * Connect page client id when the agent is recognised; null for an agent
   * set up by hand that signed in under a name of its own.
   */
  clientId: z.string().nullable(),
  /** The Connect page label, or the name the agent registered with. */
  agentName: z.string(),
  /**
   * How the event was recorded: a Connect page setup (or its disconnect), or
   * an agent's first OAuth sign-in to the gateway.
   */
  via: z.enum(["setup", "oauthSignIn"]),
  /** Connect events only. */
  platform: z.union([ConnectionSetupPlatformSchema, z.null()]),
  /** Hostname the installer reported; null for disconnects and old installers. */
  deviceName: z.string().nullable(),
  /** Gateway the agent got tools from; null when tools were left out. */
  mcpGateway: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** Whether model calls were routed through the LLM proxy. */
  modelRouting: z.boolean(),
  includeSkills: z.boolean(),
  /** Set when someone other than the user disconnected the agent. */
  disconnectedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ConnectionEvent = z.infer<typeof ConnectionEventSchema>;

/**
 * Whether a member's agents use Archestra: `active` when they made MCP gateway
 * or LLM proxy calls in the lookback window, `inactive` otherwise. Setups and
 * sign-ins alone don't count, since they only show the installer ran.
 */
export const AgentAdoptionStatusSchema = z.enum(["active", "inactive"]);
export type AgentAdoptionStatus = z.infer<typeof AgentAdoptionStatusSchema>;

/**
 * One agent's calls through one MCP gateway or LLM proxy, over the lookback
 * window: what a member's agents actually did.
 */
export const AdoptionUseSchema = z.object({
  /** The gateway or LLM proxy called; id null for the default LLM proxy. */
  via: z.object({ id: z.string().nullable(), name: z.string() }),
  /** The agent that made the calls, named best effort. */
  agent: z.object({ clientId: z.string().nullable(), name: z.string() }),
  calls: z.number(),
  lastSeenAt: z.date(),
});
export type AdoptionUse = z.infer<typeof AdoptionUseSchema>;

/** One organization member's agent connections and traffic. */
export const AgentAdoptionMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  status: AgentAdoptionStatusSchema,
  /**
   * Newest MCP gateway call from a signed-in agent in the lookback window,
   * including calls from before the gateway recorded which agent made them.
   */
  gatewayLastSeenAt: z.date().nullable(),
  /** Newest LLM proxy call in the lookback window. */
  llmLastSeenAt: z.date().nullable(),
  /** Gateway calls per gateway and agent, newest first. */
  gatewayUses: z.array(AdoptionUseSchema),
  /** LLM proxy calls per proxy and agent, newest first. */
  llmUses: z.array(AdoptionUseSchema),
  /**
   * When each agent last cloned or refreshed the skills marketplace in the
   * lookback window, newest first. Agents run skills locally, so a sync is the
   * closest Archestra sees to their use.
   */
  skillSyncs: z.array(
    z.object({
      agent: z.object({ clientId: z.string().nullable(), name: z.string() }),
      lastSyncedAt: z.date(),
    }),
  ),
});
export type AgentAdoptionMember = z.infer<typeof AgentAdoptionMemberSchema>;

export const AgentAdoptionSchema = z.object({
  /** How far back traffic is read; calls in this window make a member active. */
  lookbackDays: z.number(),
  members: z.array(AgentAdoptionMemberSchema),
});
export type AgentAdoption = z.infer<typeof AgentAdoptionSchema>;

/** Calls from members' agents per UTC day, oldest first. */
export const AgentAdoptionUsageSchema = z.object({
  lookbackDays: z.number(),
  days: z.array(
    z.object({
      /** UTC day, YYYY-MM-DD. */
      date: z.string(),
      /** MCP gateway calls from signed-in agents. */
      gatewayCalls: z.number(),
      /** LLM proxy calls from agents (external API traffic). */
      llmCalls: z.number(),
    }),
  ),
});
export type AgentAdoptionUsage = z.infer<typeof AgentAdoptionUsageSchema>;
