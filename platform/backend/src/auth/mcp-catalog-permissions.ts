// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { TeamModel } from "@/models";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { isForeignKeyConstraintError } from "@/utils/db";

/**
 * Internal MCP catalog RBAC helpers. Catalog items follow the 3-tier scope
 * model (`personal`/`team`/`org`), refined by a per-team access level: a scoped
 * team holds either `use` (discover, self-install, resolve through shared
 * installs) or `write` (`use` plus modifying the definition).
 *
 * The catalog's full-admin bypass is `update` on every registry entry — a
 * grant at `*` — which is what the retired `mcpServerInstallation:admin` role
 * action became. A `write` team grants modification to its members. Team
 * membership roles govern team administration, not access to the resources
 * shared with it.
 */
interface McpCatalogPermissionChecker {
  /** Holds `update` on every registry entry — bypasses scope restrictions. */
  isAdmin: boolean;
}

/** Fetch the user's catalog-relevant permissions once for a request. */
export async function getMcpCatalogPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<McpCatalogPermissionChecker> {
  return { isAdmin: await isMcpInstallationAdmin(params) };
}

/**
 * Whether the caller administers every MCP installation and registry entry:
 * `update` on the registry at `*`. The upgrade converted each holder of the
 * retired `mcpServerInstallation:admin` role action into exactly this grant.
 */
export async function isMcpInstallationAdmin(params: {
  userId: string;
  organizationId: string;
}): Promise<boolean> {
  return ResourcePermissions.allows({
    userId: params.userId,
    organizationId: params.organizationId,
    resource: "mcpRegistry",
    scope: "*",
    action: "update",
  });
}

/**
 * Authorize creating a catalog item at, or moving one to, the given scope and
 * teams. Unlike object modification authorization, authorship grants
 * nothing beyond `personal` scope: publishing to a team or the organization is
 * a sharing act. Object-level sharing authority is checked by the caller;
 * organization-wide publication additionally requires `admin`.
 *
 * Non-admins may only assign teams they belong to.
 */
export function authorizeMcpCatalogScope(params: {
  checker: McpCatalogPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  requestedTeamIds: string[];
  userTeamIds: string[];
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
