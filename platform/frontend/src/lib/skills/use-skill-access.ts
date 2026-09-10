// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";
import type { ScopedPermission } from "@archestra/shared";

import { computeCanModifyAgent } from "@/components/agent-pages/use-agent-access";
import { useScopedCapabilities } from "@/lib/auth/auth.query";

/**
 * The fields of a skill the scope check reads. Both the list rows and the
 * detail/edit pages carry them, so either shape satisfies it.
 */
interface SkillAccessSubject {
  id?: string;
  scope: "personal" | "team" | "org";
  authorId: string | null;
  teams: Array<{ id: string }>;
}

/**
 * The scope check every mutating control on a skill applies, on top of RBAC:
 * skill admins may touch anything, team-admins their own teams' team-scoped
 * skills, and everyone their own personal skills.
 *
 * The backend runs a skill through the same rule it runs an agent through
 * (`requireSkillModifyPermission` and `requireAgentModifyPermission` both call
 * `requireScopedModifyPermission`), so this delegates to the agent-shaped
 * check rather than keeping a second copy that could drift from it. Without
 * it the frontend showed Edit, Delete and Restore to any `skill:update`
 * holder and let the save fail with a 403.
 */
export function computeCanModifySkill({
  skill,
  isAdmin,
  isTeamAdmin,
  currentUserId,
  userTeamIds,
  scopedGrants,
}: {
  scopedGrants?: readonly ScopedPermission[];
  skill: SkillAccessSubject | null | undefined;
  isAdmin: boolean;
  isTeamAdmin: boolean;
  currentUserId: string | undefined;
  userTeamIds: ReadonlySet<string>;
}): boolean {
  if (scopedGrants !== undefined)
    return (
      !!skill &&
      scopedGrants.some(
        (grant) =>
          grant.resource === "skill" &&
          (grant.scope === "*" || grant.scope === skill.id) &&
          grant.action === "update",
      )
    );
  return computeCanModifyAgent({
    agent: skill && {
      scope: skill.scope,
      authorId: skill.authorId,
      teams: skill.teams,
    },
    isAdmin,
    isTeamAdmin,
    currentUserId,
    userTeamIds,
  });
}

/**
 * What the current user may do with one skill on its detail and edit pages:
 * `canModify` is the scope check above and `canEdit` adds the RBAC update
 * permission.
 *
 * A built-in skill needs no gate of its own — it is org-scoped, so the scope
 * check already asks for a skill admin, and editing one is supported (the
 * "reset to the shipped default" route exists precisely because a built-in
 * can be changed). Permanently deleting one is refused by the API and stays
 * gated on the global admin role, not here.
 */
export function useSkillAccess(skill: SkillAccessSubject | null | undefined) {
  const capabilities = useScopedCapabilities();
  const actions =
    capabilities.data
      ?.filter(
        (grant) =>
          grant.resource === "skill" &&
          (grant.scope === "*" || grant.scope === skill?.id),
      )
      .map((grant) => grant.action) ?? [];
  return {
    canModify: actions.includes("update"),
    canUpdate: actions.includes("update"),
    canEdit: actions.includes("update"),
    canDelete: actions.includes("delete"),
    isPending: capabilities.isPending,
  };
}
