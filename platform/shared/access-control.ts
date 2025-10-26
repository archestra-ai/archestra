import { createAccessControl } from "better-auth/plugins/access";

/**
 * Available resources
 */
export type Resource =
  | "agent"
  | "tool"
  | "policy"
  | "interaction"
  | "dualLlmConfig"
  | "dualLlmResult"
  | "settings"
  | "organization"
  | "member"
  | "invitation"
  | "internalMcpCatalog"
  | "mcpServer"
  | "team"

/**
 * Available actions
 */
export type Action = "create" | "read" | "update" | "delete";

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete"
 */
export type Permission = `${Resource}:${Action}`;

export type Role = "admin" | "member";

export const allAvailableActions: Record<Resource, Action[]> = {
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create"],
  internalMcpCatalog: ["create", "read", "update", "delete"],
  mcpServer: ["create", "read", "update", "delete"],
  team: ["create", "read", "update", "delete"],
};

export const ac = createAccessControl(allAvailableActions);

// all permissions granted
export const adminRole = ac.newRole({
  ...allAvailableActions,
});

// - read-only access for agents
// - full access to tools, policies, interactions
// - read-only access to dual LLM configs and results
// - read-only access to MCP catalog and servers
// - read-only access to teams
export const memberRole = ac.newRole({
  agent: ["read"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  dualLlmConfig: ["read"],
  dualLlmResult: ["read"],
  internalMcpCatalog: ["read"],
  mcpServer: ["read"],
  team: ["read"],
});

