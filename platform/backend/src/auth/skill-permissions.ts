import type { ResourceVisibilityScope } from "@/types/visibility";
import { requireScopedModifyPermission } from "./agent-type-permissions";
import { getPermissionsForUserContext } from "./utils";

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

/**
 * Fetch the user's skill-resource permissions once for a request. Resolves via
 * the service-account-aware lookup so token-authenticated service accounts (whose
 * synthetic `service-account:<id>` user id has no member row) get their role's
 * permissions instead of an empty set.
 */
export async function getSkillPermissionChecker(params: {
  userId: string;
  organizationId: string;
}): Promise<SkillPermissionChecker> {
  const permissions = await getPermissionsForUserContext({
    userId: params.userId,
    organizationId: params.organizationId,
  });
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
