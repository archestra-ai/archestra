import { TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { isForeignKeyConstraintError } from "@/utils/db";
import { requireScopedModifyPermission } from "./agent-type-permissions";
import { getPermissionsForUserContext } from "./utils";

/**
 * RBAC helpers for OAuth clients (MCP gateway and LLM proxy variants). Both
 * follow the same 3-tier scope model as agents/skills/catalog
 * (`personal`/`team`/`org`), with the flags read from the variant's own
 * resource: `mcpOauthClient` or `llmOauthClient`. Scope only governs who can
 * see/manage a credential — runtime token authorization is unaffected.
 */
type OauthClientResource = "llmOauthClient" | "mcpOauthClient";

export interface OauthClientPermissionChecker {
  /** Holds `<resource>:admin` — bypasses scope restrictions. */
  isAdmin: boolean;
  /** Holds `<resource>:team-admin` — may manage team-scoped clients in their teams. */
  isTeamAdmin: boolean;
}

/** Fetch the user's OAuth-client-relevant permissions once for a request. */
export async function getOauthClientPermissionChecker(params: {
  userId: string;
  organizationId: string;
  resource: OauthClientResource;
}): Promise<OauthClientPermissionChecker> {
  const permissions = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
  const actions = permissions[params.resource] ?? [];
  return {
    isAdmin: actions.includes("admin"),
    isTeamAdmin: actions.includes("team-admin"),
  };
}

/**
 * Enforces 3-tier scope authorization against an EXISTING OAuth client for
 * update/rotate-secret/delete. Throws ApiError(403) if the user lacks
 * permission.
 */
export function requireOauthClientModifyPermission(params: {
  checker: OauthClientPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  clientTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireScopedModifyPermission({
    isAdmin: params.checker.isAdmin,
    isTeamAdmin: params.checker.isTeamAdmin,
    scope: params.scope,
    authorId: params.authorId,
    resourceTeamIds: params.clientTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
    resourceLabel: "OAuth client",
  });
}

/**
 * Authorize creating an OAuth client with the given scope and teams (mirrors
 * the agent create path). Non-admins cannot create org-scoped clients; team
 * scope (or any team assignment) requires team-admin, and every assigned team
 * must be one the user belongs to.
 */
export function authorizeOauthClientCreateScope(params: {
  checker: OauthClientPermissionChecker;
  scope: ResourceVisibilityScope;
  teamIds: string[];
  userTeamIds: string[];
}): void {
  if (params.checker.isAdmin) return;

  if (params.scope === "org") {
    throw new ApiError(403, "Only admins can create org-scoped OAuth clients");
  }
  if (params.scope === "team" || params.teamIds.length > 0) {
    if (!params.checker.isTeamAdmin) {
      throw new ApiError(
        403,
        "You need team-admin permission to create team-scoped OAuth clients",
      );
    }
    const userTeamIdSet = new Set(params.userTeamIds);
    if (params.teamIds.some((id) => !userTeamIdSet.has(id))) {
      throw new ApiError(403, "You can only assign teams you are a member of");
    }
  }
}

/**
 * Validate a requested scope/teams change against the actor's permissions and
 * resolve the final team list (mirrors the agent update path). Callers must
 * have already passed {@link requireOauthClientModifyPermission} for the
 * existing client.
 *
 * - non-admin cannot escalate to `org`;
 * - non-team-admin cannot set `team` scope or touch teams;
 * - a team-admin's team edits are merged so teams outside their membership are
 *   preserved rather than silently dropped;
 * - a shared (team/org) client can never be downgraded to `personal`.
 *
 * Returns the team ids to persist (`undefined` = leave assignments untouched).
 */
export function resolveOauthClientScopeUpdate(params: {
  checker: OauthClientPermissionChecker;
  existingScope: ResourceVisibilityScope;
  existingTeamIds: string[];
  requestedScope: ResourceVisibilityScope | undefined;
  requestedTeamIds: string[] | undefined;
  userTeamIds: string[];
}): string[] | undefined {
  let teamIds = params.requestedTeamIds;

  if (!params.checker.isAdmin) {
    if (params.requestedScope === "org") {
      throw new ApiError(403, "Only admins can set scope to org");
    }
    if (params.requestedScope === "team" || (teamIds && teamIds.length > 0)) {
      if (!params.checker.isTeamAdmin) {
        throw new ApiError(
          403,
          "You need team-admin permission to set scope to team",
        );
      }
    }

    // team-admin: validate team assignments and preserve teams they don't control
    if (params.checker.isTeamAdmin && teamIds) {
      const userTeamIdSet = new Set(params.userTeamIds);
      const existingTeamIds = new Set(params.existingTeamIds);

      const invalidAdds = teamIds.filter(
        (id) => !existingTeamIds.has(id) && !userTeamIdSet.has(id),
      );
      if (invalidAdds.length > 0) {
        throw new ApiError(
          403,
          "You can only assign teams you are a member of",
        );
      }

      const preservedTeams = [...existingTeamIds].filter(
        (id) => !userTeamIdSet.has(id),
      );
      const userControlledTeams = teamIds.filter((id) => userTeamIdSet.has(id));
      teamIds = [...new Set([...userControlledTeams, ...preservedTeams])];
    }
  }

  // Prevent downgrading shared clients to personal — it would silently cut off
  // everyone else's access to the credential.
  if (
    params.requestedScope === "personal" &&
    params.existingScope !== "personal"
  ) {
    throw new ApiError(400, "Shared OAuth clients cannot be made personal");
  }

  return teamIds;
}

/**
 * Validate the teams an OAuth client is being assigned to. A `team`-scoped
 * client must have at least one team (otherwise it is invisible to everyone,
 * including its author), and every team must exist within the organization — a
 * stale/deleted id fails with a clean 400 instead of an FK violation mid-write.
 */
export async function assertOauthClientTeams(params: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.scope !== "team") return;

  if (params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped OAuth client must be assigned to at least one team",
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
 * Run an OAuth client write, converting an `oauth_client_team` foreign-key
 * violation — a team deleted between {@link assertOauthClientTeams} and the
 * insert — into a clean 400.
 */
export async function withOauthClientTeamFkErrorMapped<T>(
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
