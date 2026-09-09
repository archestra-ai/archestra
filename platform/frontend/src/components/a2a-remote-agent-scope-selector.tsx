"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import {
  UserShareField,
  useUserShareChoice,
  useUserShareOption,
} from "@/components/user-share-field";
import {
  TeamVisibilityPicker,
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
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
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  userIds: string[];
  onUserIdsChange: (ids: string[]) => void;
}) {
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: teams } = useTeams({ enabled: !!canReadTeams });
  const userOption = useUserShareOption<A2aVisibilityChoice>("user");
  const { isUserChoice, selectChoice } =
    useUserShareChoice<ResourceVisibilityScope>({
      scope,
      personalScope: "personal",
      userIds,
      onScopeChange,
      onUserIdsChange,
    });
  const choice: A2aVisibilityChoice = isUserChoice ? "user" : scope;
  const hasNoTeams = !!canReadTeams && (teams ?? []).length === 0;
  const options: VisibilityOption<A2aVisibilityChoice>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this external agent",
      icon: User,
    },
    userOption,
    {
      value: "team",
      label: "Teams",
      description: "Share this external agent with selected teams",
      icon: Users,
      disabled: !canReadTeams || hasNoTeams,
      disabledLabel: !canReadTeams
        ? "Requires permission"
        : hasNoTeams
          ? "No teams available"
          : undefined,
      disabledReason: !canReadTeams
        ? "Team sharing is unavailable without permission to view teams."
        : hasNoTeams
          ? "There are no teams to share with yet."
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your organization can use this external agent",
      icon: Globe,
    },
  ];

  return (
    <VisibilitySelector
      label="Visibility"
      value={choice}
      options={options}
      onValueChange={selectChoice}
    >
      {choice === "user" ? (
        <UserShareField value={userIds} onValueChange={onUserIdsChange} />
      ) : null}
      {choice === "team" ? (
        <TeamVisibilityPicker
          teams={teams ?? []}
          disabled={!canReadTeams || hasNoTeams}
          value={teamIds}
          onChange={onTeamIdsChange}
          required
          unavailableMessage={!canReadTeams ? "Teams unavailable" : undefined}
        />
      ) : null}
    </VisibilitySelector>
  );
}
