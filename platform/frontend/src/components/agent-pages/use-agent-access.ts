"use client";

import {
  type AgentType,
  getResourceForAgentType,
  type ScopedPermission,
} from "@archestra/shared";
import {
  useHasPermissions,
  useScopedCapabilities,
  useSession,
} from "@/lib/auth/auth.query";
import { AGENT_PAGE_CONFIGS, type AgentPageKind } from "./agent-page-config";

interface AccessSubject {
  id?: string;
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
  scopedGrants,
}: {
  scopedGrants?: readonly ScopedPermission[];
  agent: AccessSubject | null | undefined;
  isAdmin: boolean;
  isTeamAdmin: boolean;
  currentUserId: string | undefined;
  userTeamIds: ReadonlySet<string>;
}): boolean {
  if (!agent) return false;
  if (scopedGrants !== undefined)
    return scopedGrants.some(
      (grant) =>
        grant.resource ===
          getResourceForAgentType(agent.agentType ?? "agent") &&
        (grant.scope === "*" || grant.scope === agent.id) &&
        grant.action === "update",
    );
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
  const resource = agent?.agentType
    ? getResourceForAgentType(agent.agentType)
    : AGENT_PAGE_CONFIGS[kind].resource;
  const capabilities = useScopedCapabilities();
  const { data: canCreate, isPending: createPending } = useHasPermissions({
    [resource]: ["create"],
  });
  const { data: session } = useSession();
  const actions =
    capabilities.data
      ?.filter(
        (grant) =>
          grant.resource === resource &&
          (grant.scope === "*" || grant.scope === agent?.id),
      )
      .map((grant) => grant.action) ?? [];
  const isBuiltIn = !!agent?.builtIn;
  return {
    resource,
    canModify: actions.includes("update"),
    canUpdate: actions.includes("update"),
    canEdit: actions.includes("update"),
    canCreate: !!canCreate,
    canDelete: !isBuiltIn && actions.includes("delete"),
    isBuiltIn,
    currentUserId: session?.user?.id,
    isPending: capabilities.isPending || createPending,
  };
}
