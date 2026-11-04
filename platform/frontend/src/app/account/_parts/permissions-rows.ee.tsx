// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import { getRoleDisplayName, type Permissions } from "@archestra/shared";
import { ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { AccountRow, AccountRowMuted } from "@/app/account/_parts/account-rows";
import { PermissionList } from "@/components/roles/permission-list.ee";
import {
  allPermissionRows,
  countGranted,
  isGranted,
  type PermissionRow,
} from "@/components/roles/permission-list-model.ee";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAllPermissions } from "@/lib/auth/auth.query";
import { usePermissionSources } from "@/lib/auth/permission-sources.query";
import { cn } from "@/lib/utils/tailwind";

/**
 * The Permissions row of the Access box: how many are granted, and a toggle
 * that unfolds the roles pages' read-only list right under the row, inside
 * the same box. Rendered as a fragment so both rows sit in the box's list.
 */
export function PermissionsRows() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { data: permissions, isLoading, isError } = useAllPermissions();
  const granted = countGranted(permissions ?? {}, allPermissionRows);
  return (
    <>
      <AccountRow
        label="Permissions"
        action={
          granted > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Hide" : "Show"}
              <ChevronDown
                className={cn("transition-transform", open && "rotate-180")}
                aria-hidden="true"
              />
            </Button>
          )
        }
      >
        {isLoading ? (
          <Skeleton className="h-5 w-32" />
        ) : isError ? (
          <AccountRowMuted>Couldn't load</AccountRowMuted>
        ) : granted === 0 ? (
          <AccountRowMuted>None</AccountRowMuted>
        ) : (
          <span>
            <span className="font-mono tabular-nums">{granted}</span> granted
          </span>
        )}
      </AccountRow>
      {open && (
        <li id={panelId} className="bg-muted/20 px-4 py-4">
          <PermissionsPanel permissions={permissions ?? {}} />
        </li>
      )}
    </>
  );
}

/**
 * The list, with each row saying which role grants it when more than one
 * does. One source needs no saying: the Roles row above already names it.
 */
function PermissionsPanel({ permissions }: { permissions: Permissions }) {
  const { data: sources } = usePermissionSources();
  const attribution = useMemo(() => {
    if (!sources || sources.length < 2) return undefined;
    const byKey = new Map<string, string>();
    for (const row of allPermissionRows) {
      const names = sources
        .filter((source) => isGranted(source.permissions as Permissions, row))
        .map((source) =>
          source.team
            ? `${getRoleDisplayName(source.role)} via ${source.team.name}`
            : getRoleDisplayName(source.role),
        );
      if (names.length > 0) byKey.set(row.key, names.join(", "));
    }
    return (row: PermissionRow) => byKey.get(row.key) ?? null;
  }, [sources]);
  return (
    <PermissionList
      permissions={permissions}
      attribution={attribution}
      emptyMessage="Your roles and teams grant no permissions."
    />
  );
}
