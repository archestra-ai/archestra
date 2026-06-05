"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useAssignableTeams } from "@/lib/teams/team.query";

/**
 * Scope picker for the skill editor: personal / team / org. Mirrors the agent
 * access-level selector — `org` needs `skill:admin`, `team` needs
 * `skill:team-admin` (or admin), and team assignments are limited to teams the
 * server will accept.
 */
export function SkillScopeSelector({
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
}) {
  const { data: isSkillAdmin } = useHasPermissions({ skill: ["admin"] });
  const { data: isSkillTeamAdmin } = useHasPermissions({
    skill: ["team-admin"],
  });
  const { data: teams } = useAssignableTeams({
    isResourceAdmin: !!isSkillAdmin,
  });
  const canShareTeams = isSkillAdmin || isSkillTeamAdmin;
  const hasNoTeams = (teams ?? []).length === 0;

  const options: VisibilityOption<ResourceVisibilityScope>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this skill",
      icon: User,
    },
    {
      value: "team",
      label: "Teams",
      description: "Share this skill with selected teams",
      icon: Users,
      disabled: scope !== "team" && (!canShareTeams || hasNoTeams),
      disabledReason: !canShareTeams
        ? "You need skill:team-admin permission to share with teams"
        : hasNoTeams
          ? "No teams are available to share with"
          : undefined,
    },
    {
      value: "org",
      label: "Organization",
      description: "Anyone in your org can use this skill",
      icon: Globe,
      disabled: scope !== "org" && !isSkillAdmin,
      disabledReason: !isSkillAdmin
        ? "You need skill:admin permission to make this available org-wide"
        : undefined,
    },
  ];

  return (
    <VisibilitySelector
      heading="Who can use this skill"
      value={scope}
      options={options}
      onValueChange={onScopeChange}
    >
      {scope === "team" && (
        <div className="space-y-2">
          <Label>Teams</Label>
          <MultiSelectCombobox
            disabled={!canShareTeams || hasNoTeams}
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
