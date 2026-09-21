// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { z } from "zod";

export const ScopedResourceSchema = z.enum([
  "agent",
  "mcpGateway",
  "mcpRegistry",
  "skill",
  "app",
  "llmModel",
  // Objects with their own audience, the same shape as the six above.
  "project",
  "plugin",
  "knowledgeBase",
  "knowledgeConnector",
  "knowledgeFile",
  "llmVirtualKey",
  "llmProviderApiKey",
  // Deploying into a restricted environment is `use` on that environment.
  "environment",
  // A service account carries no audience of its own — the organization owns
  // every one of them — but it is still an object somebody has to be allowed
  // to manage, so it is scoped by id like the rest rather than being
  // organization-wide.
  "serviceAccount",
  // Authority over a whole class of thing, with no object to sit on. These
  // replace the `admin` role actions that let someone read rows they did not
  // create. They are granted at `*` and nowhere else, so they appear on the
  // organization Permissions screen and never on an object's own tab.
  "scheduledTask",
  "log",
  "auditLog",
]);

/**
 * Resources whose only legal scope is `*`.
 *
 * An action like `log:admin` was never about one object; it lifted a list from
 * "rows you created" to "every row". Converting it to a grant keeps that
 * meaning and makes it something a custom role can receive, which a role
 * action never could — role permission snapshots are frozen at creation.
 */
export const ORGANIZATION_WIDE_RESOURCES = new Set<ScopedResource>([
  "scheduledTask",
  "log",
  "auditLog",
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
