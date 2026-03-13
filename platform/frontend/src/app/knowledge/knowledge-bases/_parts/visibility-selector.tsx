"use client";

import type { archestraApiTypes } from "@shared";
import { CheckIcon, ChevronDown, Globe, RefreshCw, Users } from "lucide-react";
import { useState } from "react";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import { useTeams } from "@/lib/team.query";

export type KnowledgeBaseVisibility = NonNullable<
  archestraApiTypes.CreateKnowledgeBaseData["body"]["visibility"]
>;

interface VisibilityOption {
  label: string;
  description: string;
  icon: typeof Globe;
}

const VISIBILITY_OPTIONS: Record<KnowledgeBaseVisibility, VisibilityOption> = {
  "org-wide": {
    label: "Organization",
    description: "Anyone in your org can access this knowledge base",
    icon: Globe,
  },
  "team-scoped": {
    label: "Teams",
    description: "Share knowledge base with selected teams",
    icon: Users,
  },
  "auto-sync-permissions": {
    label: "Auto Sync Permissions",
    description:
      "Automatically sync permissions from the source. Documents are only accessible to users who have permission in the source system.",
    icon: RefreshCw,
  },
};

const visibilityEntries = Object.entries(VISIBILITY_OPTIONS) as [
  KnowledgeBaseVisibility,
  VisibilityOption,
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
  const [expanded, setExpanded] = useState(false);
  const { data: teams } = useTeams();
  const selected = VISIBILITY_OPTIONS[visibility];

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Visibility</Label>

        {expanded ? (
          <div className="space-y-1.5">
            {visibilityEntries.map(([value, option]) => {
              const Icon = option.icon;
              const isSelected = visibility === value;
              // TODO: Enable when ACL support is implemented
              // https://github.com/archestra-ai/archestra/issues/3218
              const noTeamsAvailable =
                value === "team-scoped" && (teams ?? []).length === 0;
              const isDisabled =
                value === "auto-sync-permissions" || noTeamsAvailable;

              const button = (
                <button
                  key={value}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => {
                    onVisibilityChange(value);
                    setExpanded(false);
                  }}
                  className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    isDisabled
                      ? "opacity-50 cursor-not-allowed"
                      : isSelected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-muted/50 cursor-pointer"
                  }`}
                >
                  <div
                    className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                      isSelected ? "bg-primary-foreground/20" : "bg-muted"
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {option.label}
                      {isDisabled && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {noTeamsAvailable
                            ? "No teams available"
                            : "Coming Soon"}
                        </span>
                      )}
                    </div>
                    <div
                      className={`text-xs ${
                        isSelected
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground"
                      }`}
                    >
                      {option.description}
                    </div>
                  </div>
                  <div
                    className={`h-4 w-4 shrink-0 rounded-full border-2 flex items-center justify-center ${
                      isSelected
                        ? "border-primary-foreground"
                        : "border-muted-foreground/30"
                    }`}
                  >
                    {isSelected && <CheckIcon className="h-2.5 w-2.5" />}
                  </div>
                </button>
              );

              return button;
            })}
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="w-full flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50 transition-colors cursor-pointer"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
              <selected.icon className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">{selected.label}</div>
              <div className="text-xs text-muted-foreground">
                {selected.description}
              </div>
            </div>
            <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
          </button>
        )}
      </div>

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
    </div>
  );
}
