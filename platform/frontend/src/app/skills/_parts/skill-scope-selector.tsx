"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, User, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  UserShareField,
  useUserShareOption,
} from "@/components/user-share-field";
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
/**
 * What this control offers. Wider than the stored scope: a skill shared with
 * named people persists as `personal` plus grants, so "user" lives only here.
 */
type SkillVisibilityChoice = ResourceVisibilityScope | "user";

export function SkillScopeSelector({
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
  userIds = [],
  onUserIdsChange,
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  /** People the skill is shared with by name; omit to hide the Users option. */
  userIds?: string[];
  onUserIdsChange?: (ids: string[]) => void;
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

  // A skill shared with named people is stored as `personal` plus grants, so
  // "user" is a reading of (scope, userIds) that this control maps both ways.
  const supportsUserSharing = onUserIdsChange !== undefined;
  const userOption = useUserShareOption<SkillVisibilityChoice>("user");
  const choice: SkillVisibilityChoice =
    scope === "personal" && userIds.length > 0 ? "user" : scope;
  const handleChoiceChange = (next: SkillVisibilityChoice) => {
    if (next === "user") {
      onScopeChange("personal");
      return;
    }
    // Leaving Users revokes what it left behind rather than stranding it.
    onUserIdsChange?.([]);
    onScopeChange(next);
  };

  const options: VisibilityOption<SkillVisibilityChoice>[] = [
    {
      value: "personal",
      label: "Personal",
      description: "Only you can use this skill",
      icon: User,
    },
    ...(supportsUserSharing ? [userOption] : []),
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
      value={choice}
      options={options}
      onValueChange={handleChoiceChange}
    >
      {choice === "user" && onUserIdsChange && (
        <UserShareField value={userIds} onValueChange={onUserIdsChange} />
      )}

      {choice === "team" && (
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
