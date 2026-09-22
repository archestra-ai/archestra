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
  "conversation",
  "agentRun",
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

/** Every selector is local to one resource type and one organization. */
export const ResourcePermissionScopeSchema = z.union([
  z.literal("*"),
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
    const required = requested;
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

type ResourcePermissionPreset = {
  label: string;
  actions: readonly ResourcePermissionAction[];
};

/**
 * The presets one resource offers, smallest first. Sessions and logs have no
 * use, update, or delete, so their top preset is read plus manage-permissions.
 */
export function resourcePermissionPresetsFor(
  resource?: ScopedResource,
): Record<string, ResourcePermissionPreset> {
  if (resource === "conversation" || resource === "agentRun") {
    return {
      view: resourcePermissionPresets.view,
      manage: {
        label: "Can manage access",
        actions: ["read", "manage-permissions"],
      },
    };
  }
  if (resource === "log" || resource === "auditLog") {
    return {
      view: resourcePermissionPresets.view,
      manage: { label: "Full access", actions: ["read", "manage-permissions"] },
    };
  }
  return resourcePermissionPresets;
}

/**
 * The smallest preset holding every action in `actions`. A grant is always one
 * preset: an action set between two presets widens to the larger one, and an
 * action the resource has no preset for is dropped first.
 */
export function widenToPreset(
  actions: readonly ResourcePermissionAction[],
  resource: ScopedResource,
): ResourcePermissionAction[] {
  const presets = Object.values(resourcePermissionPresetsFor(resource));
  const offered = new Set(presets.flatMap((preset) => preset.actions));
  const wanted = actions.filter((action) => offered.has(action));
  const preset =
    presets.find((candidate) =>
      wanted.every((action) => candidate.actions.includes(action)),
    ) ?? presets[presets.length - 1];
  return [...preset.actions];
}
