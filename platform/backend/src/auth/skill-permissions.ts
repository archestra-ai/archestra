// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { hasScopedPermission } from "@archestra/shared";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { ResourcePermissions } from "@/services/resource-permissions";
import { ApiError } from "@/types";
import type { ResourceVisibilityScope } from "@/types/visibility";
import { requireScopedModifyPermission } from "./agent-type-permissions";
import { getPermissionsForUserContext } from "./utils";

/**
 * Skill RBAC helpers. Skills follow the same 3-tier scope model as agents
 * (`personal`/`team`/`org`); these wrap the shared logic for the fixed `skill`
 * resource.
 */

export interface SkillPermissionChecker {
  isMigrated?: boolean;
  allowsScoped?: (skillId: string, action: "update" | "delete") => boolean;
  /** Holds `skill:read` — may view and use skills within their scope. */
  canRead: boolean;
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
  const grants = await ResourcePermissions.resolveAll(params);
  const policy = await ResourcePermissionPolicyModel.find({
    organizationId: params.organizationId,
    resource: "skill",
    scope: "*",
  });
  return {
    isMigrated: policy?.legacySharingMigrated ?? false,
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
    isAdmin:
      grants.some(
        (grant) =>
          grant.resource === "skill" &&
          grant.scope === "*" &&
          grant.action === "update",
      ) || skill.includes("admin"),
    isTeamAdmin:
      grants.some(
        (grant) =>
          grant.resource === "skill" &&
          grant.scope === "teams:*" &&
          grant.action === "update",
      ) || skill.includes("team-admin"),
  };
}

/**
 * Enforces 3-tier scope authorization for skill create/update/delete.
 * Throws ApiError(403) if the user lacks permission.
 */
export function requireSkillModifyPermission(params: {
  checker: SkillPermissionChecker;
  skillId?: string;
  action?: "update" | "delete";
  scope: ResourceVisibilityScope;
  authorId: string | null;
  skillTeamIds: string[];
  userTeamIds: string[];
  userId: string;
}): void {
  if (
    params.skillId &&
    params.checker.allowsScoped?.(params.skillId, params.action ?? "update")
  )
    return;
  if (params.checker.isMigrated)
    throw new ApiError(403, "You do not have permission to modify this skill");
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
