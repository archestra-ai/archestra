// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasScopedPermission } from "@archestra/shared";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import { getPermissionsForUserContext } from "./utils";

/**
 * Skill RBAC helpers. Access to an individual skill comes from grants in
 * resource_permission_policies; role actions (`skill:admin`,
 * `skill:team-admin`) confer nothing.
 */

export interface SkillPermissionChecker {
  /** True if a grant gives the action on this skill (or at `*`). */
  allowsScoped: (skillId: string, action: "update" | "delete") => boolean;
  /** Holds `skill:read`, or a read grant on some skill. */
  canRead: boolean;
  /** Holds `update` on every skill — a grant at `*` scope. */
  isAdmin: boolean;
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
  const grants = await ResourcePermissions.resolveAll(params);
  return {
    allowsScoped: (skillId, action) =>
      hasScopedPermission({
        grants,
        required: {
          organizationId: params.organizationId,
          resource: "skill",
          scope: skillId,
          action,
        },
      }),
    canRead:
      skill.includes("read") ||
      grants.some(
        (grant) => grant.resource === "skill" && grant.action === "read",
      ),
    isAdmin: grants.some(
      (grant) =>
        grant.resource === "skill" &&
        grant.scope === "*" &&
        grant.action === "update",
    ),
  };
}

/**
 * Authorizes a modification of one existing skill: the caller must hold the
 * action on that skill through a grant, on the skill itself or at `*` scope.
 * Throws ApiError(403) if not.
 */
export function requireSkillModifyPermission(params: {
  checker: SkillPermissionChecker;
  skillId: string;
  action?: "update" | "delete";
}): void {
  if (params.checker.allowsScoped(params.skillId, params.action ?? "update"))
    return;
  throw new ApiError(403, "You do not have permission to modify this skill");
}
