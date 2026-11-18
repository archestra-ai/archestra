"use client";

import { getRoleDisplayName } from "@archestra/shared";
import { getFixedRole } from "@archestra/shared/fixed-roles";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { useRoles } from "@/lib/role.query";

/**
 * The roles someone holds, in a table cell: the first two by name and a count
 * of the rest. The count unfolds the rest in place, so reading them never
 * depends on a hover and nothing floats over the table.
 */
export function AssignedRoles({ role }: { role: string }) {
  const { data: roles } = useRoles();
  const [expanded, setExpanded] = useState(false);

  // A custom role is stored by identifier; its name is what its author wrote.
  const customNames = new Map(
    (roles ?? [])
      .filter((entry) => !entry.predefined)
      .map((entry) => [entry.role, entry.name]),
  );
  const names = role
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(
      (value) =>
        getFixedRole(value)?.name ??
        customNames.get(value) ??
        getRoleDisplayName(value),
    );
  const hidden = names.length - MAX_SHOWN;
  const shown = expanded || hidden <= 0 ? names : names.slice(0, MAX_SHOWN);

  return (
    <ul
      aria-label="Roles"
      className="flex min-w-0 max-w-sm flex-wrap items-center gap-1"
    >
      {shown.map((name) => (
        <li key={name} className="flex min-w-0">
          <Badge variant="outline" className="min-w-0 shrink font-normal">
            <span className="truncate">{name}</span>
          </Badge>
        </li>
      ))}
      {hidden > 0 && (
        <li className="flex">
          <UnstyledButton
            aria-expanded={expanded}
            aria-label={
              expanded ? "Show fewer roles" : `Show ${hidden} more roles`
            }
            // The row itself is clickable; this only unfolds the list.
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((current) => !current);
            }}
            className="relative rounded-sm px-1 text-xs text-muted-foreground tabular-nums underline-offset-2 outline-none after:absolute after:-inset-2 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <span>{expanded ? "Show fewer" : `+${hidden}`}</span>
          </UnstyledButton>
        </li>
      )}
    </ul>
  );
}

const MAX_SHOWN = 2;
