"use client";

import { type AgentType, getResourceForAgentType } from "@archestra/shared";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useMyTeams } from "@/lib/teams/team.query";
import { AGENT_PAGE_CONFIGS, type AgentPageKind } from "./agent-page-config";

interface AccessSubject {
  scope: "personal" | "team" | "org";
  authorId: string | null;
  teams: Array<{ id: string }>;
  builtIn?: boolean | null;
  /**
   * The stored type, which decides the permission resource. A legacy profile
   * reached through the LLM proxy routes still answers to `agent`.
   */
  agentType?: AgentType;
}

/**
 * The scope check every mutating control on the list rows applies, on top of
 * RBAC: resource admins may touch anything, team-admins their own teams'
 * team-scoped rows, and everyone their own personal rows.
 */
export function computeCanModifyAgent({
  agent,
  isAdmin,
  isTeamAdmin,
  currentUserId,
  userTeamIds,
}: {
  agent: AccessSubject | null | undefined;
  isAdmin: boolean;
  isTeamAdmin: boolean;
  currentUserId: string | undefined;
  userTeamIds: ReadonlySet<string>;
}): boolean {
  if (!agent) return false;
  const isPersonal = agent.scope === "personal";
  const isTeamScoped = agent.scope === "team";
  const isOwner = !!currentUserId && agent.authorId === currentUserId;
  const isMemberOfAgentTeam = agent.teams.some((t) => userTeamIds.has(t.id));
  return (
    isAdmin ||
    (isTeamScoped && isTeamAdmin && isMemberOfAgentTeam) ||
    (isPersonal && isOwner)
  );
}

/**
 * What the current user may do with one agent-shaped resource on its detail
 * and edit pages: `canModify` is the scope check above, `canEdit` adds the
 * RBAC update permission, and built-in agents are org-wide records only a
 * resource admin may change.
 */
export function useAgentAccess(
  agent: AccessSubject | null | undefined,
  kind: AgentPageKind,
) {
  // The backend authorizes against the STORED type, so the route family is
  // only a stand-in until the record arrives: a profile opened under
  // `/llm/proxies/` is checked against `agent`, not `llmProxy`.
  const resource = agent?.agentType
    ? getResourceForAgentType(agent.agentType)
    : AGENT_PAGE_CONFIGS[kind].resource;
  const { data: isAdmin, isPending: isAdminPending } = useHasPermissions({
    [resource]: ["admin"],
  });
  const { data: isTeamAdmin, isPending: isTeamAdminPending } =
    useHasPermissions({
      [resource]: ["team-admin"],
    });
  const { data: canUpdate, isPending: isUpdatePending } = useHasPermissions({
    [resource]: ["update"],
  });
  const { data: canCreate } = useHasPermissions({ [resource]: ["create"] });
  const { data: canDelete } = useHasPermissions({ [resource]: ["delete"] });
  const { data: canReadTeams, isPending: isTeamsPermissionPending } =
    useHasPermissions({ team: ["read"] });
  // `isLoading`, not `isPending`: the query is disabled until the team:read
  // answer lands, and a disabled query stays `pending` forever, which would
  // leave the whole hook undecided for anyone without that permission.
  const { data: userTeams, isLoading: isTeamsLoading } = useMyTeams({
    enabled: !!canReadTeams,
  });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const canModify = computeCanModifyAgent({
    agent,
    isAdmin: !!isAdmin,
    isTeamAdmin: !!isTeamAdmin,
    currentUserId,
    userTeamIds: new Set((userTeams ?? []).map((t) => t.id)),
  });
  const isBuiltIn = !!agent?.builtIn;

  return {
    /**
     * The permission resource this record actually answers to. Anything else
     * on the page that checks a permission for it has to ask about the same
     * one, not the route family's.
     */
    resource,
    canModify,
    /**
     * The RBAC half alone. A control refused because the record is not the
     * caller's needs a different sentence from one refused because the caller
     * holds no update permission at all, and only this tells them apart.
     */
    canUpdate: !!canUpdate,
    // Built-ins belong to nobody and are org-scoped; the backend lets only
    // resource admins update them (`requireAgentModifyPermission`).
    canEdit: !!canUpdate && (isBuiltIn ? !!isAdmin : canModify),
    canCreate: !!canCreate,
    canDelete: !!canDelete && canModify && !isBuiltIn,
    isBuiltIn,
    currentUserId,
    // Every read `canModify` is composed from, not just the permission ones:
    // the teams query decides the team-admin branch, so while it is in flight
    // a team admin's own record reads as "not yours" and the control it gates
    // would flicker from refused to enabled once the answer lands.
    isPending:
      isAdminPending ||
      isUpdatePending ||
      isTeamAdminPending ||
      isTeamsPermissionPending ||
      isTeamsLoading,
  };
}
