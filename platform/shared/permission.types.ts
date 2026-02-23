/**
 * Permission type definitions for compile-time type safety.
 *
 * This file is necessary for both free and EE builds to provide type safety
 * for permission-related code, even though the non-EE version has no RBAC logic.
 *
 * - non-EE version: Uses these types but runtime logic always allows everything
 * - EE version: Uses these types with actual permission enforcement
 */
import { z } from "zod";

export const actions = [
  "create",
  "read",
  "update",
  "delete",
  "admin",
  "cancel",
] as const;

export const resources = [
  "agent",
  "mcpGateway",
  "llmProxy",
  "tool",
  "policy",
  "interaction",
  "dualLlmConfig",
  "dualLlmResult",
  "organization",
  "identityProvider",
  "member",
  "invitation",
  "internalMcpCatalog",
  "mcpServer",
  "mcpServerInstallationRequest",
  "mcpToolCall",
  "team",
  "conversation",
  "limit",
  "llmModels",
  "chatSettings",
  /**
   * Better-auth access control resource - needed for organization role management
   * See: https://github.com/better-auth/better-auth/issues/2336#issuecomment-2820620809
   *
   * The "ac" resource is part of better-auth's defaultStatements from organization plugin
   * and is required for dynamic access control to work correctly with custom roles
   */
  "ac",
] as const;

// Human-readable labels for resources
export const resourceLabels: Record<Resource, string> = {
  agent: "Agents",
  mcpGateway: "MCP Gateways",
  llmProxy: "LLM Proxies",
  tool: "Tools",
  policy: "Policies",
  interaction: "Interactions",
  dualLlmConfig: "Dual LLM Configs",
  dualLlmResult: "Dual LLM Results",
  organization: "Organization",
  identityProvider: "Identity Providers",
  member: "Members",
  invitation: "Invitations",
  internalMcpCatalog: "Internal MCP Catalog",
  mcpServer: "MCP Servers",
  mcpServerInstallationRequest: "MCP Server Installation Requests",
  mcpToolCall: "MCP Tool Calls",
  team: "Teams",
  ac: "Access Control",
  conversation: "Conversations",
  limit: "Limits",
  llmModels: "LLM Models",
  chatSettings: "Chat Settings",
};

export type Resource = (typeof resources)[number];
export type Action = (typeof actions)[number];
export type Permissions = Partial<Record<Resource, Action[]>>;

export const PermissionsSchema = z.partialRecord(
  z.enum(resources),
  z.array(z.enum(actions)),
);

/** Database-level agent type discriminator values */
export type AgentType = "profile" | "mcp_gateway" | "llm_proxy" | "agent";

/**
 * Maps an agent's `agentType` to the corresponding RBAC resource.
 *
 * - "agent" → "agent"
 * - "mcp_gateway" → "mcpGateway"
 * - "llm_proxy" → "llmProxy"
 * - "profile" → "agent" (legacy profiles use the "agent" resource)
 */
export function getResourceForAgentType(agentType: AgentType): Resource {
  switch (agentType) {
    case "mcp_gateway":
      return "mcpGateway";
    case "llm_proxy":
      return "llmProxy";
    case "agent":
    case "profile":
      return "agent";
  }
}
