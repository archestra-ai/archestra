"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  UserShareField,
  useUserShareChoice,
  useUserShareOption,
} from "@/components/user-share-field";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

type PluginVisibilityChoice = ResourceVisibilityScope | "user";

export function PluginScopeSelector({
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
  const { data: isPluginAdmin } = useHasPermissions({ plugin: ["admin"] });
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isPluginAdmin,
  });
  const hasNoTeams = (teams ?? []).length === 0;
  const userOption = useUserShareOption<PluginVisibilityChoice>("user");
  const { isUserChoice, selectChoice } =
    useUserShareChoice<ResourceVisibilityScope>({
      scope,
      personalScope: "personal",
      userIds,
      onScopeChange,
      onUserIdsChange,
    });
  const choice: PluginVisibilityChoice = isUserChoice ? "user" : scope;
  const options: VisibilityOption<PluginVisibilityChoice>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can discover this plugin",
      icon: User,
    },
    userOption,
    {
      value: "team",
      label: "Teams",
      description: "Share this plugin with selected teams",
      icon: Users,
      disabled: scope !== "team" && (!isPluginAdmin || hasNoTeams),
      disabledLabel: !isPluginAdmin
        ? "Requires permission"
        : hasNoTeams
          ? "No teams available"
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your organization can discover this plugin",
      icon: Globe,
      disabled: scope !== "org" && !isPluginAdmin,
      disabledLabel: !isPluginAdmin ? "Requires permission" : undefined,
    },
  ];

  return (
    <VisibilitySelector
      heading="Who can discover this plugin"
      value={choice}
      options={options}
      onValueChange={selectChoice}
    >
      {choice === "user" && (
        <UserShareField value={userIds} onValueChange={onUserIdsChange} />
      )}
      {choice === "team" && (
        <div className="space-y-2">
          <Label>Teams</Label>
          <MultiSelectCombobox
            disabled={!isPluginAdmin || hasNoTeams}
            options={
              teams?.map((team) => ({ value: team.id, label: team.name })) ?? []
            }
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={hasNoTeams ? "No teams available" : "Search teams..."}
            emptyMessage="No teams found."
          />
        </div>
      )}
    </VisibilitySelector>
  );
}
