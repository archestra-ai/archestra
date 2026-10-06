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
 * Where a member stands with their agents, judged by traffic rather than by
 * setup tickets: a ticket only proves the installer fetched its script.
 * - `active`: gateway or LLM proxy traffic in the active window
 * - `inactive`: traffic in the lookback window, none in the active window
 * - `setUp`: a redeemed setup or a gateway OAuth sign-in, but no traffic in
 *   the lookback window
 * - `notConnected`: no setup and no traffic
 */
export const AgentAdoptionStatusSchema = z.enum([
  "active",
  "inactive",
  "setUp",
  "notConnected",
]);
export type AgentAdoptionStatus = z.infer<typeof AgentAdoptionStatusSchema>;

/**
 * One agent a member connected or used: set up from the Connect page, signed
 * in to the gateway with OAuth, or seen on the gateway or the LLM proxy.
 */
export const AdoptionAgentSchema = z.object({
  /**
   * Connect page client id when the agent is recognised ("claude-code",
   * "amp", ...; LLM proxy calls may carry any id the generic instructions
   * sent), else null.
   */
  clientId: z.string().nullable(),
  /** The Connect page label, or the name the agent registered or sent. */
  name: z.string(),
  /** Newest redeemed, not disconnected Connect page setup. */
  setUpAt: z.date().nullable(),
  /** First OAuth sign-in to the gateway. */
  signedInAt: z.date().nullable(),
  /** Newest gateway call from this agent in the lookback window. */
  gatewayLastSeenAt: z.date().nullable(),
  /** Newest LLM proxy call from this agent in the lookback window. */
  llmLastSeenAt: z.date().nullable(),
});
export type AdoptionAgent = z.infer<typeof AdoptionAgentSchema>;

/** One organization member's agent connections and traffic. */
export const AgentAdoptionMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  status: AgentAdoptionStatusSchema,
  agents: z.array(AdoptionAgentSchema),
  /**
   * Newest MCP gateway call from a signed-in agent in the lookback window,
   * including calls from before the gateway recorded which agent made them.
   */
  gatewayLastSeenAt: z.date().nullable(),
  /** Newest LLM proxy call in the lookback window. */
  llmLastSeenAt: z.date().nullable(),
  /** Newest skill activation through the gateway in the lookback window. */
  skillLastUsedAt: z.date().nullable(),
});
export type AgentAdoptionMember = z.infer<typeof AgentAdoptionMemberSchema>;

export const AgentAdoptionSchema = z.object({
  /** Traffic newer than this many days counts as active. */
  activeDays: z.number(),
  /** How far back traffic is read. */
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
