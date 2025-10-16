import { createAccessControl } from "better-auth/plugins/access";

/**
 * Create Access Control instance
 */
export const ac = createAccessControl({
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

/**
 * Owner role - has all permissions
 */
export const ownerRole = ac.newRole({
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update", "delete"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

/**
 * Admin role - has all permissions except org deletion/transfer
 */
export const adminRole = ac.newRole({
  agent: ["create", "read", "update", "delete"],
  tool: ["create", "read", "update", "delete"],
  policy: ["create", "read", "update", "delete"],
  dualLlmConfig: ["create", "read", "update", "delete"],
  dualLlmResult: ["create", "read", "update", "delete"],
  interaction: ["create", "read", "update", "delete"],
  settings: ["read", "update"],
  organization: ["create", "read", "update"],
  member: ["create", "update", "delete"],
  invitation: ["create", "cancel"],
});

/**
 * Member role - read-only access
 */
export const memberRole = ac.newRole({
  agent: ["read"],
  tool: ["read"],
  policy: ["read"],
  dualLlmConfig: ["read"],
  dualLlmResult: ["read"],
  interaction: ["read"],
  settings: ["read"],
  organization: ["read"],
  member: [],
  invitation: [],
});
