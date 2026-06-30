import { requireScopedModifyPermission } from "@/auth/agent-type-permissions";
import { userHasPermission } from "@/auth/utils";
import { TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { AppScope } from "@/types/app";

/**
 * Dedupe the requested team ids and assert every one belongs to the caller's
 * org, throwing `ApiError(400)` otherwise. Shared by the REST app routes and the
 * `publish_app` MCP tool so neither can assign an app to a foreign-org team or
 * a team id that does not exist.
 */
export async function resolveOrgTeamIds(
  teamIds: string[] | undefined,
  organizationId: string,
): Promise<string[]> {
  const unique = [...new Set(teamIds ?? [])];
  if (unique.length === 0) return [];
  const teams = await TeamModel.findByIds(unique);
  const inOrg = new Set(
    teams.filter((t) => t.organizationId === organizationId).map((t) => t.id),
  );
  const invalid = unique.filter((id) => !inOrg.has(id));
  if (invalid.length > 0) {
    throw new ApiError(
      400,
      `Unknown team(s) for this organization: ${invalid.join(", ")}`,
    );
  }
  return unique;
}

/**
 * Shared app write-authorization, used by both the create/update/delete
 * Archestra MCP tools and the REST CRUD routes so the rule lives in one place.
 *
 * Visibility (being able to view an app) is NOT enough to mutate it: an
 * org-scoped app is visible to every member but only an admin may change it.
 * Delegates to the same 3-tier scope rule agents/skills use (admin bypass /
 * org→admin / team→team-admin+membership / personal→authorship).
 */

/** Whether the caller holds the org-wide `app:admin` permission. */
export async function callerIsAppAdmin(
  userId: string,
  organizationId: string,
): Promise<boolean> {
  return userHasPermission(userId, organizationId, "app", "admin");
}

/**
 * Throw `ApiError(403)` unless the caller may modify an app with the given
 * scope/author/teams. For a re-scope, call once per scope (current + target).
 */
export async function assertCallerMayModifyApp(params: {
  userId: string;
  organizationId: string;
  scope: AppScope;
  authorId: string | null;
  resourceTeamIds: string[];
}): Promise<void> {
  const [isAdmin, isTeamAdmin, userTeamIds] = await Promise.all([
    userHasPermission(params.userId, params.organizationId, "app", "admin"),
    userHasPermission(
      params.userId,
      params.organizationId,
      "app",
      "team-admin",
    ),
    TeamModel.getUserTeamIds(params.userId),
  ]);
  requireScopedModifyPermission({
    isAdmin,
    isTeamAdmin,
    scope: params.scope,
    authorId: params.authorId,
    resourceTeamIds: params.resourceTeamIds,
    userTeamIds,
    userId: params.userId,
    resourceLabel: "app",
  });
}
