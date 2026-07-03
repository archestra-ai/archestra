import { requireScopedModifyPermission } from "@/auth/agent-type-permissions";
import { userHasPermission } from "@/auth/utils";
import { TeamModel } from "@/models";
import { ApiError } from "@/types";
import type { AppScope } from "@/types/app";

/**
 * Resolve requested team references — team ids or team names — to a deduped
 * list of team ids, asserting every one belongs to the caller's org and
 * throwing `ApiError(400)` otherwise. Shared by the REST app routes (which
 * pass ids) and the `publish_app` MCP tool (where the model passes whatever
 * the user said, usually a team name) so neither can assign an app to a
 * foreign-org team or a team that does not exist. Names match exactly first,
 * then case-insensitively when that is unambiguous.
 */
export async function resolveOrgTeams(
  teamRefs: string[] | undefined,
  organizationId: string,
): Promise<string[]> {
  const unique = [...new Set((teamRefs ?? []).map((ref) => ref.trim()))];
  if (unique.length === 0) return [];
  const orgTeams = await TeamModel.findByOrganization(organizationId);
  const teamsById = new Map(orgTeams.map((team) => [team.id, team]));
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const ref of unique) {
    const byId = teamsById.get(ref);
    if (byId) {
      resolved.add(byId.id);
      continue;
    }
    const exact = orgTeams.filter((team) => team.name === ref);
    const matches =
      exact.length > 0
        ? exact
        : orgTeams.filter(
            (team) => team.name.toLowerCase() === ref.toLowerCase(),
          );
    if (matches.length > 1) {
      throw new ApiError(
        400,
        `Team name "${ref}" is ambiguous in this organization; pass the team id instead.`,
      );
    }
    if (matches.length === 1) {
      resolved.add(matches[0].id);
      continue;
    }
    unknown.push(ref);
  }
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      `Unknown team(s) for this organization: ${unknown.join(", ")}`,
    );
  }
  return [...resolved];
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
