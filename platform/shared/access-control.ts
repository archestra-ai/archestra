import { createAccessControl } from "better-auth/plugins/access";
import { z } from "zod";

export const ADMIN_ROLE_NAME = "admin";
export const MEMBER_ROLE_NAME = "member";
export const PredefinedRoleNameSchema = z.enum([ADMIN_ROLE_NAME, MEMBER_ROLE_NAME]);
export const AnyRoleName = PredefinedRoleNameSchema.or(z.string());

export const ActionSchema = z.enum(["create", "read", "update", "delete", "admin"]);

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

export const RolePermissionsSchema = z.partialRecord(
  ResourceSchema,
  z.array(ActionSchema),
);

export const allAvailableActions: Record<Resource, Action[]> = {
  agent: ["create", "read", "update", "delete", "admin"],
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
  mcpServer: ["create", "read", "update", "delete", "admin"],
  mcpServerInstallationRequest: ["create", "read", "update", "delete", "admin"],
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

export const rolePermissionsMap: Record<PredefinedRoleName, RolePermissions> = {
  [ADMIN_ROLE_NAME]: adminRole.statements,
  [MEMBER_ROLE_NAME]: memberRole.statements,
};

/**
 * Available resources and actions
 */
export type Resource = z.infer<typeof ResourceSchema>;
export type Action = z.infer<typeof ActionSchema>;

/**
 * Permission string format: "resource:action"
 * Examples: "agent:create", "tool:read", "org:delete", "agent:admin", "mcpServer:admin"
 *
 * Note: "admin" action is only valid for certain resources
 */
export type Permission =
  | `${Resource}:${"create" | "read" | "update" | "delete"}`
  | "agent:admin"
  | "mcpServer:admin"
  | "mcpServerInstallationRequest:admin";

export type RolePermissions = z.infer<typeof RolePermissionsSchema>;
export type PredefinedRoleName = z.infer<typeof PredefinedRoleNameSchema>;
export type AnyRoleName = z.infer<typeof AnyRoleName>;
