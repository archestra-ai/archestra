// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { z } from "zod";

export const ScopedResourceSchema = z.enum([
  "agent",
  "mcpGateway",
  "mcpRegistry",
  "skill",
  "app",
  "llmModel",
]);

export const ResourcePermissionActionSchema = z.enum([
  "read",
  "use",
  "update",
  "delete",
  "manage-permissions",
]);

/** Matches resources with a direct grant to one of the acting user's teams. */
export const TEAM_RESOURCE_SCOPE = "teams:*";

/** Every selector is local to one resource type and one organization. */
export const ResourcePermissionScopeSchema = z.union([
  z.literal("*"),
  z.literal(TEAM_RESOURCE_SCOPE),
  z.string().uuid(),
]);

export const PermissionSubjectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), id: z.string().min(1) }),
  z.object({ type: z.literal("team"), id: z.string().min(1) }),
  z.object({ type: z.literal("serviceAccount"), id: z.string().uuid() }),
  z.object({ type: z.literal("role"), id: z.string().min(1) }),
  z.object({ type: z.literal("organization"), id: z.literal("*") }),
]);

export const ResourcePermissionGrantSchema = z.object({
  subject: PermissionSubjectSchema,
  actions: z.array(ResourcePermissionActionSchema).min(1).max(5),
});

export type ScopedResource = z.infer<typeof ScopedResourceSchema>;
export type ResourcePermissionAction = z.infer<
  typeof ResourcePermissionActionSchema
>;
export type ResourcePermissionScope = z.infer<
  typeof ResourcePermissionScopeSchema
>;
export type PermissionSubject = z.infer<typeof PermissionSubjectSchema>;
export type ResourcePermissionGrant = z.infer<
  typeof ResourcePermissionGrantSchema
>;

export type ScopedPermission = {
  organizationId: string;
  resource: ScopedResource;
  scope: ResourcePermissionScope;
  action: ResourcePermissionAction;
};

/** Check the whole tuple: independent action/scope unions escalate access. */
export function hasScopedPermission(params: {
  grants: readonly ScopedPermission[];
  required: ScopedPermission;
}): boolean {
  return params.grants.some(
    (grant) =>
      grant.organizationId === params.required.organizationId &&
      grant.resource === params.required.resource &&
      grant.action === params.required.action &&
      (grant.scope === "*" || grant.scope === params.required.scope),
  );
}

/** Grant management alone never authorizes delegating actions not held. */
export function canDelegateScopedPermissions(params: {
  grants: readonly ScopedPermission[];
  requested: readonly ScopedPermission[];
}): boolean {
  return params.requested.every((requested) => {
    // A recipient's teams may reach objects outside the grantor's teams.
    // Only resource-wide authority can delegate a recipient-relative scope.
    const required =
      requested.scope === TEAM_RESOURCE_SCOPE
        ? { ...requested, scope: "*" }
        : requested;
    return (
      hasScopedPermission({ grants: params.grants, required }) &&
      hasScopedPermission({
        grants: params.grants,
        required: { ...required, action: "manage-permissions" },
      })
    );
  });
}

export const resourcePermissionPresets = {
  view: { label: "Can view", actions: ["read"] },
  use: { label: "Can use", actions: ["read", "use"] },
  edit: { label: "Can edit", actions: ["read", "use", "update"] },
  manage: {
    label: "Full access",
    actions: ["read", "use", "update", "delete", "manage-permissions"],
  },
} satisfies Record<
  string,
  { label: string; actions: ResourcePermissionAction[] }
>;
