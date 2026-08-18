"use client";

import type { ResourceVisibilityScope } from "@archestra/shared";
import { Globe, Lock, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  type VisibilityOption,
  VisibilitySelector,
} from "@/components/visibility-selector";
import { useTeams } from "@/lib/teams/team.query";

/**
 * Who can see and manage a batch analysis, in the app-wide scope vocabulary
 * (the same one agents and skills use, so the badge in the table reads the
 * same). Defaults to personal on create: an analysis names an agent whose
 * credential its runs spend, and its cells quote source documents its creator
 * could read.
 */
const OPTIONS: VisibilityOption<ResourceVisibilityScope>[] = [
  {
    value: "org",
    label: "Organization",
    description: "Anyone in your organization can open and run it",
    icon: Globe,
  },
  {
    value: "team",
    label: "Teams",
    description: "Only members of the teams you pick",
    icon: Users,
  },
  {
    value: "personal",
    label: "Only me",
    description: "Nobody else can open, run or edit it",
    icon: Lock,
  },
];

export function AnalysisScopeSelector({
  scope,
  onScopeChange,
  teamIds,
  onTeamIdsChange,
  label = "Who can see this",
  description,
}: {
  scope: ResourceVisibilityScope;
  onScopeChange: (scope: ResourceVisibilityScope) => void;
  teamIds: string[];
  onTeamIdsChange: (teamIds: string[]) => void;
  label?: string;
  description?: string;
}) {
  const { data: teams } = useTeams();

  return (
    <div className="space-y-2">
      <VisibilitySelector
        label={label}
        description={description}
        value={scope}
        options={OPTIONS}
        onValueChange={onScopeChange}
      />

      {scope === "team" && (
        <div className="space-y-1.5">
          <Label htmlFor="analysis-scope-teams">Teams</Label>
          <MultiSelectCombobox
            options={(teams ?? []).map((team) => ({
              value: team.id,
              label: team.name,
            }))}
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder="Select teams"
            emptyMessage="No teams yet"
          />
          <p className="text-muted-foreground text-xs">
            {teamIds.length === 0
              ? "Pick at least one team, or nobody will be able to see this."
              : "Team scope replaces personal access — join one of these teams to keep seeing it yourself."}
          </p>
        </div>
      )}
    </div>
  );
}
