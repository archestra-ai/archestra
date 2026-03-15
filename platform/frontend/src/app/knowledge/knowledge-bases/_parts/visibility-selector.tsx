"use client";

import type { archestraApiTypes } from "@shared";
import { Globe, RefreshCw, Users } from "lucide-react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  VisibilitySelector as SharedVisibilitySelector,
  type VisibilityOption,
} from "@/components/visibility-selector";
import { useTeams } from "@/lib/team.query";

export type KnowledgeBaseVisibility = NonNullable<
  archestraApiTypes.CreateKnowledgeBaseData["body"]["visibility"]
>;

const VISIBILITY_OPTIONS: Record<
  KnowledgeBaseVisibility,
  VisibilityOption<KnowledgeBaseVisibility>
> = {
  "org-wide": {
    value: "org-wide",
    label: "Organization",
    description: "Anyone in your org can access this knowledge base",
    icon: Globe,
  },
  "team-scoped": {
    value: "team-scoped",
    label: "Teams",
    description: "Share knowledge base with selected teams",
    icon: Users,
  },
  "auto-sync-permissions": {
    value: "auto-sync-permissions",
    label: "Auto Sync Permissions",
    description:
      "Automatically sync permissions from the source. Documents are only accessible to users who have permission in the source system.",
    icon: RefreshCw,
  },
};

const visibilityEntries = Object.entries(VISIBILITY_OPTIONS) as [
  KnowledgeBaseVisibility,
  VisibilityOption<KnowledgeBaseVisibility>,
][];

export function VisibilitySelector({
  visibility,
  onVisibilityChange,
  teamIds,
  onTeamIdsChange,
  showTeamRequired,
}: {
  visibility: KnowledgeBaseVisibility;
  onVisibilityChange: (visibility: KnowledgeBaseVisibility) => void;
  teamIds: string[];
  onTeamIdsChange: (ids: string[]) => void;
  showTeamRequired?: boolean;
}) {
  const { data: teams } = useTeams();

  const options = visibilityEntries.map(([value, option]) => {
    const noTeamsAvailable =
      value === "team-scoped" && (teams ?? []).length === 0;
    const isDisabled = value === "auto-sync-permissions" || noTeamsAvailable;

    return {
      ...option,
      value,
      disabled: isDisabled,
      disabledLabel: noTeamsAvailable
        ? "No teams available"
        : value === "auto-sync-permissions"
          ? "Coming Soon"
          : undefined,
    } satisfies VisibilityOption<KnowledgeBaseVisibility>;
  });

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
