import { TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { isForeignKeyConstraintError } from "@/utils/db";
import { requireScopedModifyPermission } from "./agent-type-permissions";
import { getPermissionsForUserContext } from "./utils";

/**
 * Internal MCP catalog RBAC helpers. Catalog items follow the same 3-tier scope
 * model as agents/skills (`personal`/`team`/`org`). Unlike skills — where both
 * flags come from one resource — the catalog's full-admin bypass lives on
 * `mcpServerInstallation:admin` (the existing catalog admin gate), while the new
 * team-scoped capability is `mcpRegistry:team-admin`.
 */
interface McpCatalogPermissionChecker {
  /** Holds `mcpServerInstallation:admin` — bypasses scope restrictions. */
  isAdmin: boolean;
  /** Holds `mcpRegistry:team-admin` — may manage team-scoped items in their teams. */
  isTeamAdmin: boolean;
}

/** Fetch the user's catalog-relevant permissions once for a request. */
export async function getMcpCatalogPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<McpCatalogPermissionChecker> {
  const permissions = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  return {
    isAdmin: (permissions.mcpServerInstallation ?? []).includes("admin"),
    isTeamAdmin: (permissions.mcpRegistry ?? []).includes("team-admin"),
  };
}

/**
 * Enforces 3-tier scope authorization for catalog create/update/reinstall.
 * Throws ApiError(403) if the user lacks permission.
 */
export function requireMcpCatalogModifyPermission(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  catalogTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireScopedModifyPermission({
    isAdmin: params.checker.isAdmin,
    isTeamAdmin: params.checker.isTeamAdmin,
    scope: params.scope,
    authorId: params.authorId,
    resourceTeamIds: params.catalogTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
    resourceLabel: "catalog item",
  });
}

/**
 * Authorize creating/moving a catalog item to the given scope and teams.
 * Enforces the 3-tier scope check and, for non-admins, that every assigned team
 * is one the user belongs to.
 */
export function authorizeMcpCatalogScope(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  requestedTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireMcpCatalogModifyPermission({
    checker: params.checker,
    scope: params.scope,
    authorId: params.authorId,
    catalogTeamIds: params.requestedTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
  });

  if (!params.checker.isAdmin && params.scope === "team") {
    const userTeamIdSet = new Set(params.userTeamIds);
    if (params.requestedTeamIds.some((id) => !userTeamIdSet.has(id))) {
      throw new ApiError(
        403,
        "You can only assign catalog items to teams you are a member of",
      );
    }
  }
}

/**
 * Validate the teams a catalog item is being assigned to. A `team`-scoped item
 * must have at least one team (otherwise it is invisible to everyone, including
 * its author), and every team must exist within the organization — a
 * stale/deleted id fails with a clean 400 instead of an FK violation mid-write.
 */
export async function assertMcpCatalogTeams(params: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.scope !== "team") return;

  if (params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped catalog item must be assigned to at least one team",
    );
  }

  const teams = await TeamModel.findByIds(params.teamIds);
  const validIds = new Set(
    teams
      .filter((team) => team.organizationId === params.organizationId)
      .map((team) => team.id),
  );
  const missing = params.teamIds.filter((id) => !validIds.has(id));
  if (missing.length > 0) {
    throw new ApiError(400, `Unknown team id(s): ${missing.join(", ")}`);
  }
}

/**
 * Run a catalog write, converting an `mcp_catalog_team` foreign-key violation —
 * a team deleted between {@link assertMcpCatalogTeams} and the insert — into a
 * clean 400.
 */
export async function withCatalogTeamFkErrorMapped<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isForeignKeyConstraintError(error)) {
      throw new ApiError(
        400,
        "One or more of the selected teams no longer exist",
      );
    }
    throw error;
  }
}
