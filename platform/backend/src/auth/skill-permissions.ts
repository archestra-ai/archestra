import { TeamModel, UserModel } from "@/models";
import { ApiError } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { isForeignKeyConstraintError } from "@/utils/db";
import { requireScopedModifyPermission } from "./agent-type-permissions";

/**
 * Skill RBAC helpers. Skills follow the same 3-tier scope model as agents
 * (`personal`/`team`/`org`); these wrap the shared logic for the fixed `skill`
 * resource.
 */

export interface SkillPermissionChecker {
  /** Holds `skill:read` — may view and use skills within their scope. */
  canRead: boolean;
  /** Holds `skill:execute` — may run skill scripts in a sandboxed runtime. */
  canExecute: boolean;
  /** Holds `skill:admin` — bypasses scope restrictions. */
  isAdmin: boolean;
  /** Holds `skill:team-admin` — may manage team-scoped skills in their teams. */
  isTeamAdmin: boolean;
}

/** Fetch the user's skill-resource permissions once for a request. */
export async function getSkillPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<SkillPermissionChecker> {
  const permissions = await UserModel.getUserPermissions(
    params.userId,
    params.organizationId,
  );
  const skill = permissions.skill ?? [];
  return {
    canRead: skill.includes("read"),
    canExecute: skill.includes("execute"),
    isAdmin: skill.includes("admin"),
    isTeamAdmin: skill.includes("team-admin"),
  };
}

/**
 * Enforces 3-tier scope authorization for skill create/update/delete.
 * Throws ApiError(403) if the user lacks permission.
 */
export function requireSkillModifyPermission(params: {
  checker: SkillPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  skillTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireScopedModifyPermission({
    isAdmin: params.checker.isAdmin,
    isTeamAdmin: params.checker.isTeamAdmin,
    scope: params.scope,
    authorId: params.authorId,
    resourceTeamIds: params.skillTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
    resourceLabel: "skill",
  });
}

/**
 * Authorize creating/moving a skill to the given scope and teams. Enforces the
 * 3-tier scope check and, for non-admins, that every assigned team is one the
 * user belongs to. Shared by the REST routes and the `create_skill` MCP tool so
 * both gate scoped creation identically. Throws ApiError(403) on denial.
 */
export function authorizeSkillScope(params: {
  checker: SkillPermissionChecker;
  scope: ResourceVisibilityScope;
  authorId: string | null;
  requestedTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  requireSkillModifyPermission({
    checker: params.checker,
    scope: params.scope,
    authorId: params.authorId,
    skillTeamIds: params.requestedTeamIds,
    userTeamIds: params.userTeamIds,
    userId: params.userId,
  });

  if (!params.checker.isAdmin && params.scope === "team") {
    const userTeamIdSet = new Set(params.userTeamIds);
    if (params.requestedTeamIds.some((id) => !userTeamIdSet.has(id))) {
      throw new ApiError(
        403,
        "You can only assign skills to teams you are a member of",
      );
    }
  }
}

/**
 * Validate the team ids a team-scoped skill is assigned to: at least one, and
 * every id an existing team in this organization. No-op for non-team scopes.
 * Throws ApiError(400) on a bad assignment.
 */
export async function assertSkillTeams(params: {
  scope: ResourceVisibilityScope;
  teamIds: string[];
  organizationId: string;
}): Promise<void> {
  if (params.scope !== "team") return;

  if (params.teamIds.length === 0) {
    throw new ApiError(
      400,
      "A team-scoped skill must be assigned to at least one team",
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
 * Run a skill write, converting a `skill_team` foreign-key violation — a team
 * deleted between {@link assertSkillTeams} and the insert — into a clean 400.
 */
export async function withTeamFkErrorMapped<T>(
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
