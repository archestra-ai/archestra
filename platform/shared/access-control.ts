import { createAccessControl } from "better-auth/plugins/access";
import { z } from "zod";

export const ActionSchema = z.enum(["create", "read", "update", "delete"]);

export const ResourceSchema = z.enum([
  "agent",
  "tool",
  "policy",
  "interaction",
  "dualLlmConfig",
  "dualLlmResult",
  "settings",
  "organization",
  "member",
  "invitation",
  "internalMcpCatalog",
  "mcpServer",
  "mcpServerInstallationRequest",
  "mcpToolCall",
  "team",
  "conversation",
  "limit",
  "tokenPrice",
]);

/**
 * Available resources and actions
 */
export type Resource = z.infer<typeof ResourceSchema>;
export type Action = z.infer<typeof ActionSchema>;

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete"
 */
export type Permission = `${Resource}:${Action}`;

/**
 * TODO: it's not very clear how owner role is assigned/inferred, it is mentioned in the
 * better-auth docs https://www.better-auth.com/docs/plugins/organization#deleting-a-role
 * but still not clear how it works/is-assigned
 */
export const OWNER_ROLE_NAME = "owner";
export const ADMIN_ROLE_NAME = "admin";
export const MEMBER_ROLE_NAME = "member";
export const ALL_PREDEFINED_ROLES = [OWNER_ROLE_NAME, ADMIN_ROLE_NAME, MEMBER_ROLE_NAME];
export const RoleSchema = z.union([
  z.literal(OWNER_ROLE_NAME),
  z.literal(ADMIN_ROLE_NAME),
  z.literal(MEMBER_ROLE_NAME),
  z.string(),
]);
export type Role = z.infer<typeof RoleSchema>;

/**
 * Check if a role is a custom role (not predefined)
 */
export function isCustomRole(role: Role): boolean {
  return !ALL_PREDEFINED_ROLES.includes(role);
}

/**
 * Get permissions for a predefined role
 */
export function getPredefinedRolePermissions(
  role: Role,
): Record<Resource, Action[]> {
  if (role === ADMIN_ROLE_NAME) {
    return allAvailableActions;
  }
  return memberRole.statements as Record<Resource, Action[]>;
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
  organization: ["read"],
  team: ["read"],
  mcpToolCall: ["read"],
  conversation: ["create", "read", "update", "delete"],
  limit: ["read"],
  tokenPrice: ["read"],
});

