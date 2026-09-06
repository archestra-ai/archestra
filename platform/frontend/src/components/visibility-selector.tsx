"use client";

import type { LucideIcon } from "lucide-react";
import { CheckIcon, ChevronDown, GitBranch } from "lucide-react";
import { useState } from "react";
import { FieldDescription } from "@/components/ui/field-description";
import { Label } from "@/components/ui/label";
import { MultiSelectCombobox } from "@/components/ui/multi-select-combobox";
import {
  formatTeamPath,
  getTeamDescendantIds,
  type TeamHierarchyNode,
} from "@/lib/teams/team-hierarchy";

export type VisibilityOption<Value extends string> = {
  value: Value;
  label: string;
  description: string;
  icon?: LucideIcon;
  disabled?: boolean;
  /** Short inline note beside the label, e.g. "No teams available". */
  disabledLabel?: string;
  /** The full explanation, shown in place of the description while disabled. */
  disabledReason?: string;
};

export function VisibilitySelector<Value extends string>({
  label = "Visibility",
  description,
  heading,
  value,
  options,
  onValueChange,
  readOnly = false,
  children,
}: {
  label?: string;
  description?: React.ReactNode;
  heading?: string;
  value: Value;
  options: VisibilityOption<Value>[];
  onValueChange: (value: Value) => void;
  readOnly?: boolean;
  children?: React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected =
    options.find((option) => option.value === value) ?? options[0];
  const isStatic = options.length <= 1 || readOnly;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="space-y-1">
          {heading ? (
            <h3 className="text-sm font-semibold">{heading}</h3>
          ) : (
            <Label>{label}</Label>
          )}
          {description ? (
            <FieldDescription>{description}</FieldDescription>
          ) : null}
        </div>

        {isStatic ? (
          <div className="w-full rounded-lg border p-3">
            <div className="flex items-center gap-3">
              {selected.icon ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <selected.icon className="h-4 w-4" />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{selected.label}</div>
                <div className="text-xs text-muted-foreground">
                  {selected.description}
                </div>
              </div>
            </div>
          </div>
        ) : expanded ? (
          <div className="space-y-1.5">
            {options.map((option) => {
              const Icon = option.icon;
              const isSelected = value === option.value;
              const button = (
                <button
                  key={option.value}
                  type="button"
                  disabled={option.disabled}
                  onClick={() => {
                    if (!option.disabled) {
                      onValueChange(option.value);
                      setExpanded(false);
                    }
                  }}
                  className={`w-full flex items-center gap-3 rounded-lg border p-3 text-left transition-colors ${
                    option.disabled
                      ? "opacity-50 cursor-not-allowed"
                      : isSelected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "hover:bg-muted/50 cursor-pointer"
                  }`}
                >
                  {Icon ? (
                    <div
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${
                        isSelected ? "bg-primary-foreground/20" : "bg-muted"
                      }`}
                    >
                      <Icon className="h-4 w-4" />
                    </div>
                  ) : null}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">
                      {option.label}
                      {option.disabledLabel && (
                        <span className="ml-2 text-xs font-normal text-muted-foreground">
                          {option.disabledLabel}
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
                      {/* Why an option can't be picked belongs in the row that
                          can't be picked. A tooltip hides it behind a hover the
                          reader has no reason to try, and anchors to whichever
                          row it feels like when several are disabled. */}
                      {option.disabled && option.disabledReason
                        ? option.disabledReason
                        : option.description}
                    </div>
                  </div>
                  <div
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
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
            className="w-full cursor-pointer rounded-lg border p-3 text-left transition-colors hover:bg-muted/50"
          >
            <div className="flex items-center gap-3">
              {selected.icon ? (
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                  <selected.icon className="h-4 w-4" />
                </div>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{selected.label}</div>
                <div className="text-xs text-muted-foreground">
                  {selected.description}
                </div>
              </div>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
            </div>
          </button>
        )}
      </div>

      {children}
    </div>
  );
}

export function TeamVisibilityPicker({
  teams,
  value,
  onChange,
  disabled = false,
  required = false,
  unavailableMessage,
}: {
  teams: TeamHierarchyNode[];
  value: string[];
  onChange: (teamIds: string[]) => void;
  disabled?: boolean;
  required?: boolean;
  unavailableMessage?: string;
}) {
  const selectedIds = new Set(value);
  const inheritedIds = new Set(
    value.flatMap((teamId) => getTeamDescendantIds(teams, teamId)),
  );
  const inheritedById = new Map<string, { id: string; name: string }>();
  for (const team of teams) {
    if (inheritedIds.has(team.id)) inheritedById.set(team.id, team);
    if (selectedIds.has(team.id)) {
      for (const descendant of team.descendantTeams ?? []) {
        inheritedById.set(descendant.id, descendant);
      }
    }
  }
  const inheritedTeams = [...inheritedById.values()].filter(
    (team) => !selectedIds.has(team.id),
  );
  const inheritedNames = inheritedTeams
    .slice(0, 4)
    .map((team) => team.name)
    .join(", ");
  const remainingCount = inheritedTeams.length - 4;
  const inheritedAccessLabel = `Also available to ${inheritedTeams.length} child ${inheritedTeams.length === 1 ? "team" : "teams"}`;
  const inheritedTeamNames = `${inheritedNames}${remainingCount > 0 ? `, and ${remainingCount} more` : ""}`;

  return (
    <div className="space-y-2">
      <Label>Teams{required && <span> *</span>}</Label>
      <MultiSelectCombobox
        disabled={disabled}
        options={teams.map((team) => ({
          value: team.id,
          label: team.name,
          description:
            team.parentId === null ? undefined : formatTeamPath(teams, team.id),
        }))}
        value={value}
        onChange={onChange}
        placeholder={
          unavailableMessage ??
          (teams.length === 0 ? "No teams available" : "Search teams...")
        }
        emptyMessage="No teams found."
      />
      {inheritedTeams.length > 0 && (
        <div
          className="flex gap-2 rounded-md border bg-muted/30 px-3 py-2 text-xs"
          aria-live="polite"
        >
          <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium">{inheritedAccessLabel}</p>
            <p className="truncate text-muted-foreground">
              {inheritedTeamNames}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
