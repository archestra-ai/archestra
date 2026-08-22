"use client";

import { computeCanModifyAgent } from "@/components/agent-pages/use-agent-access";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";

/**
 * The fields of a skill the scope check reads. Both the list rows and the
 * detail/edit pages carry them, so either shape satisfies it.
 */
interface SkillAccessSubject {
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
}: {
  skill: SkillAccessSubject | null | undefined;
  isAdmin: boolean;
  isTeamAdmin: boolean;
  currentUserId: string | undefined;
  userTeamIds: ReadonlySet<string>;
}): boolean {
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
  const { data: isAdmin, isPending: isAdminPending } = useHasPermissions({
    skill: ["admin"],
  });
  const { data: isTeamAdmin, isPending: isTeamAdminPending } =
    useHasPermissions({ skill: ["team-admin"] });
  const { data: canUpdate, isPending: isUpdatePending } = useHasPermissions({
    skill: ["update"],
  });
  const { data: canDelete } = useHasPermissions({ skill: ["delete"] });
  const { data: canReadTeams, isPending: isTeamsPermissionPending } =
    useHasPermissions({ team: ["read"] });
  // `isLoading`, not `isPending`: the query is disabled until the team:read
  // answer lands, and a disabled query stays `pending` forever, which would
  // leave the whole hook undecided for anyone without that permission.
  const { data: userTeams, isLoading: isTeamsLoading } = useMyTeams({
    enabled: !!canReadTeams,
  });
  const { data: session } = useSession();

  const canModify = computeCanModifySkill({
    skill,
    isAdmin: !!isAdmin,
    isTeamAdmin: !!isTeamAdmin,
    currentUserId: session?.user?.id,
    userTeamIds: new Set((userTeams ?? []).map((team) => team.id)),
  });

  return {
    canModify,
    /**
     * The RBAC half alone. A control refused because the skill is not the
     * caller's needs a different sentence from one refused because the caller
     * holds no `skill:update` at all, and only this tells them apart.
     */
    canUpdate: !!canUpdate,
    canEdit: !!canUpdate && canModify,
    canDelete: !!canDelete && canModify,
    // Every read `canModify` is composed from, not just the permission ones:
    // the teams query decides the team-admin branch, so while it is in flight
    // a team admin's own skill reads as "not yours" and the control it gates
    // would flicker from refused to enabled once the answer lands.
    isPending:
      isAdminPending ||
      isUpdatePending ||
      isTeamAdminPending ||
      isTeamsPermissionPending ||
      isTeamsLoading,
  };
}
