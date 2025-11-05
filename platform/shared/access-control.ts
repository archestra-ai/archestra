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
  | "mcpServerInstallationRequest"
  | "mcpToolCall"
  | "team"
  | "conversation"
  | "limit"
  | "tokenPrice"

/**
 * Available actions
 */
export type Action = "create" | "read" | "update" | "delete";

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete"
 */
export type Permission = `${Resource}:${Action}`;

export type Role = "admin" | "member" | string; // Allow custom role names

/**
 * Type for creating a custom role
 */
export interface CustomRoleRequest {
  name: string;
  permissions: Partial<Record<Resource, Action[]>>;
  organizationId: string;
}

/**
 * Type for role definition (response from API)
 */
export interface RoleDefinition {
  id: string;
  name: string;
  permissions: Record<Resource, Action[]>;
  isCustom: boolean;
  organizationId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Check if a role is a custom role (not predefined)
 */
export function isCustomRole(role: string): boolean {
  return !["admin", "member"].includes(role);
}

/**
 * Get permissions for a predefined role
 */
export function getPredefinedRolePermissions(
  role: "admin" | "member",
): Record<Resource, Action[]> {
  if (role === "admin") {
    return allAvailableActions;
  }
  return memberRole.permissions as Record<Resource, Action[]>;
}

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
  mcpServerInstallationRequest: ["create", "read", "update", "delete"],
  team: ["create", "read", "update", "delete"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["create", "read", "update", "delete"],
  tokenPrice: ["create", "read", "update", "delete"],
};

export const ac = createAccessControl(allAvailableActions);

// all permissions granted
export const adminRole = ac.newRole({
  ...allAvailableActions,
});

// - read-only access for agents
// - full access to tools, policies, interactions
// - read-only access to dual LLM configs and results
// - read-only access to MCP catalog
// - can create MCP servers (personal auth only), read, and delete (personal auth only)
// - can create and read MCP server installation requests
// - read-only access to teams
// - full access to conversations
export const memberRole = ac.newRole({
  agent: ["read"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  dualLlmConfig: ["read"],
  dualLlmResult: ["read"],
  internalMcpCatalog: ["read"],
  mcpServer: ["create", "read", "delete"],
  mcpServerInstallationRequest: ["create", "read", "update"],
  team: ["read"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["read"],
  tokenPrice: ["read"],
});

