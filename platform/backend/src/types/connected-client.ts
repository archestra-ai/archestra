import { z } from "zod";
import {
  type ConnectionSetupPlatform,
  ConnectionSetupPlatformSchema,
} from "./connection-setup";

/**
 * A connected agent: a Connect client id (a setup client, or an agent the
 * gateway recognises from its sign-in), or `oauth:<OAuth client id>` for an
 * agent known only from its gateway sign-in.
 */
export const ConnectedClientIdSchema = z.string().min(1).max(2048);
export type ConnectedClientId = z.infer<typeof ConnectedClientIdSchema>;

/**
 * One coding client the user connected, from their redeemed setup tickets or,
 * for agents set up by hand, their gateway OAuth sign-in (one entry per
 * client). What the Connect page reads.
 */
export const ConnectedClientSchema = z.object({
  clientId: ConnectedClientIdSchema,
  /** The Connect page name, or the name the agent registered with. */
  name: z.string(),
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
  /** LLM proxy the agent's model calls were routed through; null when not. */
  llmProxy: z.object({ id: z.string(), name: z.string() }).nullable(),
  includeSkills: z.boolean(),
  /** How many skills the setup synced; deleted skills drop out. */
  skillCount: z.number(),
  /** Set when someone other than the user disconnected the agent. */
  disconnectedBy: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ConnectionEvent = z.infer<typeof ConnectionEventSchema>;

/**
 * Where a user, or one of their agents, stands over the last 30 days, whatever
 * date range is picked: `active` when an agent did something (a gateway tool
 * call or an LLM proxy call), `inactive` when it reached the gateway or proxy
 * (opening it counts) but did nothing, `notConnected` when it never reached
 * either. A setup or sign-in with no traffic is not connected. A user stands
 * where their most active connected agent does; disconnected ones don't count.
 */
export const AgentAdoptionStatusSchema = z.enum([
  "active",
  "inactive",
  "notConnected",
]);
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

/** One of a member's agents: how it got there, and what it did. */
export const AdoptionAgentSchema = z.object({
  /** Connect page client id; null for an agent known only by its name. */
  clientId: z.string().nullable(),
  name: z.string(),
  status: AgentAdoptionStatusSchema,
  /** First setup, or first gateway sign-in; null when only seen in traffic. */
  setupAt: z.date().nullable(),
  /** Set up by hand: known from its gateway sign-in. */
  signedIn: z.boolean(),
  /** Seen only calling on a pasted token: no setup and no sign-in. */
  viaToken: z.boolean(),
  lastGatewayCallAt: z.date().nullable(),
  lastLlmCallAt: z.date().nullable(),
});
export type AdoptionAgent = z.infer<typeof AdoptionAgentSchema>;

/** One organization member's agent connections and traffic. */
export const AgentAdoptionMemberSchema = z.object({
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  status: AgentAdoptionStatusSchema,
  /**
   * Newest MCP gateway tool call from the member's agents, however old,
   * within a 180-day lookback; null when none. Starting an agent isn't one.
   */
  gatewayLastSeenAt: z.date().nullable(),
  /** Newest LLM proxy call, within the same lookback. */
  llmLastSeenAt: z.date().nullable(),
  /**
   * Each agent the member set up, signed in with, or was seen calling from,
   * with its own state and last calls.
   */
  agents: z.array(AdoptionAgentSchema),
  /** Gateway calls in the picked range, per gateway and agent, newest first. */
  gatewayUses: z.array(AdoptionUseSchema),
  /** LLM proxy calls in the picked range, per proxy and agent, newest first. */
  llmUses: z.array(AdoptionUseSchema),
});
export type AgentAdoptionMember = z.infer<typeof AgentAdoptionMemberSchema>;

export const AgentAdoptionSchema = z.object({
  /** The span traffic is read over; calls in it make a member active. */
  since: z.date(),
  until: z.date(),
  members: z.array(AgentAdoptionMemberSchema),
});
export type AgentAdoption = z.infer<typeof AgentAdoptionSchema>;

/** Calls from members' agents per UTC day, oldest first. */
export const AgentAdoptionUsageSchema = z.object({
  since: z.date(),
  until: z.date(),
  days: z.array(
    z.object({
      /** UTC day, YYYY-MM-DD. */
      date: z.string(),
      /** MCP gateway tool calls from users' agents. */
      gatewayCalls: z.number(),
      /** LLM proxy calls from agents (external API traffic). */
      llmCalls: z.number(),
    }),
  ),
});
export type AgentAdoptionUsage = z.infer<typeof AgentAdoptionUsageSchema>;
