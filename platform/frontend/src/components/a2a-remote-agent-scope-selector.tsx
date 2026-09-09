"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { AccessLevelSelector } from "@/components/agent-form";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useTeams } from "@/lib/teams/team.query";

type A2aVisibilityChoice = ResourceVisibilityScope | "user";

export function A2aRemoteAgentScopeSelector({
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
  userIds,
  onUserIdsChange,
  onChoiceChange,
  initialScope,
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  userIds: string[];
  onUserIdsChange: (ids: string[]) => void;
  onChoiceChange?: (choice: A2aVisibilityChoice) => void;
  initialScope?: ResourceVisibilityScope;
}) {
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: canManageExternalAgents } = useHasPermissions({
    agentSettings: ["update"],
  });
  const { data: isAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({ agent: ["team-admin"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });
  const hasNoAvailableTeams = !!canReadTeams && (teams ?? []).length === 0;

  return (
    <AccessLevelSelector
      scope={scope}
      onScopeChange={onScopeChange}
      onChoiceChange={onChoiceChange}
      initialScope={initialScope}
      isAdmin={!!isAdmin || !!canManageExternalAgents}
      isTeamAdmin={!!isTeamAdmin || !!canManageExternalAgents}
      canReadTeams={!!canReadTeams}
      agentType="agent"
      teams={teams}
      assignedTeamIds={teamIds}
      onTeamIdsChange={onTeamIdsChange}
      assignedUserIds={userIds}
      onUserIdsChange={onUserIdsChange}
      hasNoAvailableTeams={hasNoAvailableTeams}
      showTeamRequired
    />
  );
}
