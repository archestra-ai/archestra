// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  Permissions,
  ResourcePermissionAction,
  ScopedPermission,
  ScopedResource,
} from "@archestra/shared";

/**
 * Translate the pre-scope authorization contract without treating an elevated
 * action as an independent CRUD grant. Kept separate so migration parity is
 * testable against the old resource checks.
 */
export function resolveLegacyResourcePermissions(params: {
  organizationId: string;
  resource: ScopedResource;
  scope: string;
  userId: string;
  permissions: Permissions;
  teamIds: string[];
  target: {
    authorId: string | null;
    scope: "personal" | "team" | "org";
    teams: { id: string; level?: "use" | "write" }[];
    users: { id: string }[];
    enabled?: boolean;
  } | null;
}): ScopedPermission[] {
  const actions = params.permissions[params.resource] ?? [];
  const catalog = params.resource === "mcpRegistry";
  const isAdmin = catalog
    ? (params.permissions.mcpServerInstallation ?? []).includes("admin")
    : actions.includes("admin");
  const target = params.target;
  const owner = !!target && target.authorId === params.userId;
  if (params.resource === "app" && target?.enabled === false && !owner)
    return [];
  const teamMember = !!target?.teams.some((team) =>
    params.teamIds.includes(team.id),
  );
  if (params.resource === "llmModel") {
    const catalogManager = actions.includes("update");
    const unrestricted = target?.scope === "org";
    const namedReader = target?.users.some((user) => user.id === params.userId);
    const allowed: ResourcePermissionAction[] = [];
    if (
      actions.includes("read") &&
      (catalogManager || unrestricted || teamMember || namedReader)
    )
      allowed.push("read");
    // The old proxy enforces team restrictions independently of catalog read.
    // Named model sharing currently affects discovery only, not invocation.
    if (catalogManager || unrestricted || teamMember) allowed.push("use");
    if (catalogManager) allowed.push("update", "manage-permissions");
    return allowed.map((action) => ({
      organizationId: params.organizationId,
      resource: params.resource,
      scope: params.scope,
      action,
    }));
  }
  const visible =
    isAdmin ||
    (!!target &&
      (target.scope === "org" ||
        (target.scope === "personal" &&
          (owner ||
            (!catalog &&
              target.users.some((user) => user.id === params.userId)))) ||
        (target.scope === "team" && teamMember)));
  const canModify =
    isAdmin ||
    (!!target &&
      ((target.scope === "personal" && owner) ||
        (target.scope === "team" &&
          (catalog
            ? target.teams.some(
                (team) =>
                  team.level === "write" && params.teamIds.includes(team.id),
              )
            : actions.includes("team-admin") && teamMember))));
  const canDelete = catalog
    ? isAdmin || (target?.scope === "personal" && owner)
    : canModify;
  const granted: ResourcePermissionAction[] = [];
  if (actions.includes("read") && visible) granted.push("read", "use");
  // Install routes historically gate creation of the installation separately
  // from catalog discovery. A caller can install a visible definition without
  // holding the catalog's read action (for example, an automation-only role).
  if (
    catalog &&
    visible &&
    (params.permissions.mcpServerInstallation ?? []).includes("create")
  )
    granted.push("use");
  if (actions.includes("update") && canModify)
    granted.push("update", "manage-permissions");
  if (actions.includes("delete") && canDelete) granted.push("delete");
  return [...new Set(granted)].map((action) => ({
    organizationId: params.organizationId,
    resource: params.resource,
    scope: params.scope,
    action,
  }));
}
