import { TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { CatalogTeamAccessLevel } from "@/types/catalog-team-level";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { isForeignKeyConstraintError } from "@/utils/db";
import { getPermissionsForUserContext } from "./utils";

/**
 * Internal MCP catalog RBAC helpers. Catalog items follow the 3-tier scope
 * model (`personal`/`team`/`org`), refined by a per-team access level: a scoped
 * team holds either `use` (discover, self-install, resolve through shared
 * installs) or `write` (`use` plus modifying the definition).
 *
 * The catalog's full-admin bypass lives on `mcpServerInstallation:admin`.
 * A `write` team's modify capability is exercised by that team's admins —
 * membership in a `write` team confers `use` only.
 */
interface McpCatalogPermissionChecker {
  /** Holds `mcpServerInstallation:admin` — bypasses scope restrictions. */
  isAdmin: boolean;
}

/** A catalog item's scoped team, with the level resolved (NULL reads as `write`). */
export interface CatalogTeamAccess {
  id: string;
  level: CatalogTeamAccessLevel;
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
  };
}

/**
 * Teams whose `write` level this user may exercise: the teams they administer.
 */
export async function getCatalogWriteMembershipTeamIds(
  userId: string,
): Promise<string[]> {
  return TeamModel.getUserAdminTeamIds(userId);
}

function writeLevelTeamIds(catalogTeams: CatalogTeamAccess[]): string[] {
  return catalogTeams
    .filter((team) => team.level === "write")
    .map((team) => team.id);
}

function intersects(a: string[], b: string[]): boolean {
  const set = new Set(b);
  return a.some((id) => set.has(id));
}

/**
 * Enforces write authorization for editing an existing catalog item
 * (update/reinstall/refresh). Throws ApiError(403) if the user lacks it.
 *
 * Admins bypass; a team-scoped item is writable by an admin of one of its
 * `write`-level teams; a personal item by its author. Authorship confers
 * nothing once an item is shared — an org-scoped item an admin promoted stays
 * admin-only, whoever wrote it.
 */
export function requireMcpCatalogModifyPermission(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  catalogTeams: CatalogTeamAccess[];
  writeMembershipTeamIds: string[];
  userId: string;
}): void {
  if (params.checker.isAdmin) return;

  switch (params.scope) {
    case "org":
      throw new ApiError(
        403,
        "Only admins can manage org-scoped catalog items",
      );

    case "team": {
      const writableTeamIds = writeLevelTeamIds(params.catalogTeams);
      if (!intersects(writableTeamIds, params.writeMembershipTeamIds)) {
        throw new ApiError(
          403,
          "You need to be an admin of a team with write access to manage this catalog item",
        );
      }
      return;
    }

    case "personal":
      if (params.authorId !== params.userId) {
        throw new ApiError(
          403,
          "You can only manage your own personal catalog items",
        );
      }
      return;

    // Fail closed: an out-of-union scope (data corruption, manual write, or a
    // future scope shipped before this code is updated) must be denied.
    default:
      throw new ApiError(403, "Unknown catalog item scope");
  }
}

/**
 * Authorize creating a catalog item at, or moving one to, the given scope and
 * teams. Unlike {@link requireMcpCatalogModifyPermission}, authorship grants
 * nothing beyond `personal` scope: publishing to a team or the organization is
 * a sharing act, gated by team administration and `admin` respectively.
 *
 * Non-admins may only assign teams they belong to.
 */
export function authorizeMcpCatalogScope(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  requestedTeamIds: string[];
  userTeamIds: string[];
  writeMembershipTeamIds: string[];
  userId: string;
}): void {
  if (params.checker.isAdmin) return;

  switch (params.scope) {
    case "org":
      throw new ApiError(
        403,
        "Only admins can manage org-scoped catalog items",
      );

    case "team": {
      const { requestedTeamIds } = params;
      // An empty list is a validation error (a team item needs a team), not an
      // authorization one — let assertMcpCatalogTeams raise the 400 rather than
      // masking it with a 403 here.
      if (requestedTeamIds.length === 0) return;
      const userTeamIdSet = new Set(params.userTeamIds);
      if (requestedTeamIds.some((id) => !userTeamIdSet.has(id))) {
        throw new ApiError(
          403,
          "You can only assign catalog items to teams you are a member of",
        );
      }
      if (!intersects(requestedTeamIds, params.writeMembershipTeamIds)) {
        throw new ApiError(
          403,
          "You need to be a team-admin of one of the selected teams to share a catalog item with them",
        );
      }
      return;
    }

    case "personal":
      if (params.authorId !== params.userId) {
        throw new ApiError(
          403,
          "You can only manage your own personal catalog items",
        );
      }
      return;

    default:
      throw new ApiError(403, "Unknown catalog item scope");
  }
}

/**
 * Deleting a catalog item destroys every install and secret bag it owns, so it
 * stays reserved for admins and, for a personal item, its author — a `write`
 * team level does not confer it.
 */
export function requireMcpCatalogDeletePermission(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  userId: string;
}): void {
  if (params.checker.isAdmin) return;
  if (params.scope === "personal" && params.authorId === params.userId) return;

  throw new ApiError(
    403,
    "You can only delete your own personal catalog items",
  );
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
