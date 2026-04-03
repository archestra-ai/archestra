"use client";

import { Globe, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import { useTeams } from "@/lib/teams/team.query";

export type KnowledgeSourceVisibility = "org-wide" | "team-scoped";

const VISIBILITY_OPTIONS: Record<
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>
> = {
  "org-wide": {
    value: "org-wide",
    label: "Organization",
    description: "Anyone in your org can access this knowledge source",
    icon: Globe,
  },
  "team-scoped": {
    value: "team-scoped",
    label: "Teams",
    description: "Share this knowledge source with selected teams",
    icon: Users,
  },
};

const visibilityEntries = Object.entries(VISIBILITY_OPTIONS) as [
  KnowledgeSourceVisibility,
  VisibilityOption<KnowledgeSourceVisibility>,
][];

export function KnowledgeSourceVisibilitySelector({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  showTeamRequired,
}: {
  visibility: KnowledgeSourceVisibility;
  onVisibilityChange: (visibility: KnowledgeSourceVisibility) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  showTeamRequired?: boolean;
}) {
  const { data: teams } = useTeams();

  const options = visibilityEntries.map(([value, option]) => ({
    ...option,
    value,
    disabled: value === "team-scoped" && (teams ?? []).length === 0,
    disabledLabel:
      value === "team-scoped" && (teams ?? []).length === 0
        ? "No teams available"
        : undefined,
  }));

  return (
    <SharedVisibilitySelector
      value={visibility}
      options={options}
      onValueChange={onVisibilityChange}
    >
      {visibility === "team-scoped" && (
        <div className="space-y-2">
          <Label>
            Teams
            {showTeamRequired && (
              <span className="text-destructive ml-1">(required)</span>
            )}
          </Label>
          <MultiSelectCombobox
            options={
              teams?.map((team) => ({
                value: team.id,
                label: team.name,
              })) || []
            }
            value={teamIds}
            onChange={onTeamIdsChange}
            placeholder={
              teams?.length === 0 ? "No teams available" : "Search teams..."
            }
            emptyMessage="No teams found."
          />
        </div>
      )}
    </SharedVisibilitySelector>
  );
}
