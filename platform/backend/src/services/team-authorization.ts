import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { hasAnyAgentTypeAdminPermission } from "@/auth/agent-type-permissions";
import { AgentToolModel, TeamModel } from "@/models";
import type { Team } from "@/types";
import type { TeamMemberRole } from "@/types/team-role";

/**
 * Shared team authorization + invariant logic, consumed by both the REST
 * `/api/teams` routes and the Archestra MCP team tools so the two interfaces
 * enforce identical rules.
 *
 * These functions are deliberately interface-agnostic: they take resolved
 * primitives and return booleans / typed results rather than throwing
 * `ApiError` or returning an MCP `CallToolResult`. Each caller maps a denial to
 * its own error shape (REST → `ApiError`, MCP → `errorResult`).
 *
 * In particular, "is this caller an org-level team manager?" is NOT resolved
 * here: the REST routes derive it from `hasPermission(headers)` (which honors
 * API-key / service-account scoping), while the MCP tools derive it from
 * `userHasPermission(userId, organizationId, …)`. Callers pass the resolved
 * `isOrgTeamManager` flag in.
 */

/**
 * Fetch a team scoped to an organization. Returns null when the team does not
 * exist or belongs to a different org, so callers can never read or mutate
 * teams outside the caller's organization.
 */
export async function getTeamForOrg(params: {
  teamId: string;
  organizationId: string;
}): Promise<Team | null> {
  const team = await TeamModel.findById(params.teamId);
  if (!team || team.organizationId !== params.organizationId) {
    return null;
  }
  return team;
}

/**
 * Whether the caller may manage a team's membership: an org-level team manager
 * may manage any team; otherwise the caller must be an admin of that specific
 * team.
 */
export async function canManageTeamMembers(params: {
  isOrgTeamManager: boolean;
  userId: string;
  teamId: string;
}): Promise<boolean> {
  if (params.isOrgTeamManager) {
    return true;
  }
  return TeamModel.isUserTeamAdmin(params.teamId, params.userId);
}

/**
 * Whether the caller may read a team: an org-level team manager sees every
 * team; otherwise the caller must be a member of the team.
 */
export async function canReadTeam(params: {
  isOrgTeamManager: boolean;
  userId: string;
  teamId: string;
}): Promise<boolean> {
  if (params.isOrgTeamManager) {
    return true;
  }
  return TeamModel.isUserInTeam(params.teamId, params.userId);
}

type LastAdminCheck =
  | { ok: true }
  | { ok: false; reason: "member_not_found" | "last_admin" };

/**
 * Enforce that a role change or removal does not strip a team of its final
 * admin. `nextRole` is the role the member would end up with (`null` when the
 * member is being removed entirely).
 */
export async function checkLastAdminInvariant(params: {
  teamId: string;
  userId: string;
  nextRole: TeamMemberRole | null;
}): Promise<LastAdminCheck> {
  const members = await TeamModel.getTeamMembers(params.teamId);
  const target = members.find((member) => member.userId === params.userId);

  if (!target) {
    return { ok: false, reason: "member_not_found" };
  }

  // Only a demotion/removal of a current admin can reduce the admin count.
  if (target.role !== ADMIN_ROLE_NAME || params.nextRole === ADMIN_ROLE_NAME) {
    return { ok: true };
  }

  const adminCount = members.filter(
    (member) => member.role === ADMIN_ROLE_NAME,
  ).length;
  if (adminCount <= 1) {
    return { ok: false, reason: "last_admin" };
  }

  return { ok: true };
}

/**
 * After removing a user from a team, drop the personal-credential (static MCP
 * server) assignments they can no longer reach through any team. Returns the
 * number of assignments cleaned. Callers decide whether to treat a failure as
 * fatal (both current callers run this best-effort).
 */
export async function cleanupCredentialSourcesAfterMemberRemoval(params: {
  actingUserId: string;
  removedUserId: string;
  teamId: string;
  organizationId: string;
}): Promise<number> {
  const actingUserIsAgentAdmin = await hasAnyAgentTypeAdminPermission({
    userId: params.actingUserId,
    organizationId: params.organizationId,
  });
  return AgentToolModel.cleanupInvalidCredentialSourcesForUser(
    params.removedUserId,
    params.teamId,
    actingUserIsAgentAdmin,
  );
}
