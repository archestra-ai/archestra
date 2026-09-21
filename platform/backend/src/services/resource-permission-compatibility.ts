// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import type {
  Permissions,
  ResourcePermissionAction,
  ScopedPermission,
  ScopedResource,
} from "@archestra/shared";
import { roleActionResourceFor } from "@archestra/shared/access-control";

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
  const actions =
    params.permissions[roleActionResourceFor(params.resource)] ?? [];
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
  if (params.resource === "environment") {
    // DO NOT DELETE THIS BRANCH. It looks like a special case for a resource
    // that could fall through to the generic rules below. It cannot.
    //
    // An environment has no author and no visibility column, so it resolves as
    // organization-scoped, and the generic rule turns the `read` action plus
    // organization scope into `read` AND `use`. Migration 0355 gave
    // `environment:read` to every custom role, so every role in every
    // organization would come out of here holding `use` on every environment
    // — which is the key to every restricted environment, standing open for
    // the entire pre-conversion window.
    //
    // Deploying into a restricted environment was never the read action: it
    // was `deploy-to-restricted`, and that is what `use` has to mean here
    // until the conversion replaces it with real grants.
    const allowed: ResourcePermissionAction[] = [];
    if (actions.includes("read")) allowed.push("read");
    if (holdsLegacyDeployToRestricted(params.permissions)) allowed.push("use");
    if (actions.includes("update"))
      allowed.push("update", "manage-permissions");
    if (actions.includes("delete")) allowed.push("delete");
    return allowed.map((action) => ({
      organizationId: params.organizationId,
      resource: params.resource,
      scope: params.scope,
      action,
    }));
  }
  if (params.resource === "serviceAccount") {
    // A service account belongs to the organization and names no audience, so
    // the generic rules below would call it organization-wide and then refuse
    // every write: `canModify` only ever says yes for an owner, a write-level
    // team or an `admin` action, and a service account has none of the three.
    // Reaching one was purely a question of the caller's role actions, so that
    // is what converts.
    const allowed: ResourcePermissionAction[] = [];
    if (actions.includes("read")) allowed.push("read", "use");
    if (actions.includes("update"))
      allowed.push("update", "manage-permissions");
    if (actions.includes("delete")) allowed.push("delete");
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

/**
 * The resources whose retired `deploy-to-restricted` action let a principal
 * deploy into a restricted environment.
 *
 * Holding it on any one of them is enough. The retired action discriminated on
 * the kind of object being deployed; `environment:use` discriminates on the
 * environment instead, so the kinds collapse together here. Nobody who could
 * deploy loses the ability, and the widening is confined to a hand-authored
 * role that held a strict subset of the six.
 */
const DEPLOY_TO_RESTRICTED_RESOURCES = [
  "agent",
  "skill",
  "app",
  "mcpGateway",
  "mcpRegistry",
  "knowledgeSource",
] as const;

function holdsLegacyDeployToRestricted(permissions: Permissions): boolean {
  return DEPLOY_TO_RESTRICTED_RESOURCES.some((resource) =>
    permissions[resource]?.includes("deploy-to-restricted"),
  );
}
