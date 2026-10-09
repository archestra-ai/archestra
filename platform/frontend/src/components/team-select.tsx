"use client";

import { CircleDashed, UsersRound } from "lucide-react";
import type { ReactNode } from "react";
import { SearchableSelect } from "@/components/ui/searchable-select";
import type { Team } from "@/lib/teams/team.query";

/**
 * Pick one team. Each option shows the team the way the permission pickers do
 * (a round team icon, the name, and a muted subtitle), with the member count
 * and description, so similarly named teams can be told apart.
 */
export function TeamSelect({
  id,
  ariaLabel,
  value,
  onValueChange,
  teams,
  noneOption,
  placeholder = "Select a team",
  className,
  disabled,
}: {
  id?: string;
  ariaLabel?: string;
  /** The team id, or null for the none option. */
  value: string | null;
  onValueChange: (teamId: string | null) => void;
  teams: Pick<Team, "id" | "name" | "description" | "members">[];
  /** A standing "no team" choice, pinned above the search results. */
  noneOption?: { label: string; description?: string };
  placeholder?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <SearchableSelect
      id={id}
      ariaLabel={ariaLabel}
      value={value ?? (noneOption ? NONE : "")}
      onValueChange={(next) => onValueChange(next === NONE ? null : next)}
      placeholder={placeholder}
      searchPlaceholder="Search teams"
      emptyMessage="No matching teams."
      className={className}
      disabled={disabled}
      pinnedItems={
        noneOption
          ? [
              {
                value: NONE,
                label: noneOption.label,
                content: (
                  <TeamRow
                    icon={<CircleDashed className="size-3" aria-hidden />}
                    name={noneOption.label}
                    subtitle={noneOption.description}
                  />
                ),
                selectedContent: (
                  <TeamChip
                    icon={<CircleDashed className="size-2.5" aria-hidden />}
                    name={noneOption.label}
                  />
                ),
              },
            ]
          : undefined
      }
      items={teams.map((team) => ({
        value: team.id,
        label: team.name,
        searchText: `${team.name} ${team.description ?? ""}`,
        content: (
          <TeamRow
            icon={<UsersRound className="size-3" aria-hidden />}
            name={team.name}
            subtitle={describeTeam(team)}
          />
        ),
        selectedContent: (
          <TeamChip
            icon={<UsersRound className="size-2.5" aria-hidden />}
            name={team.name}
          />
        ),
      }))}
    />
  );
}

// ===

const NONE = "__none__";

function describeTeam(
  team: Pick<Team, "description" | "members">,
): string | undefined {
  const count = team.members?.length;
  const members =
    count === undefined
      ? null
      : `${count} ${count === 1 ? "member" : "members"}`;
  return (
    [members, team.description?.trim() || null].filter(Boolean).join(" · ") ||
    undefined
  );
}

function TeamRow({
  icon,
  name,
  subtitle,
}: {
  icon: ReactNode;
  name: string;
  subtitle?: string;
}) {
  return (
    <div className="flex min-h-8 min-w-0 items-center gap-2">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted">
        {icon}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium">{name}</span>
        {subtitle && (
          <span className="truncate text-xs text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
    </div>
  );
}

function TeamChip({ icon, name }: { icon: ReactNode; name: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-muted">
        {icon}
      </span>
      <span className="truncate">{name}</span>
    </div>
  );
}
