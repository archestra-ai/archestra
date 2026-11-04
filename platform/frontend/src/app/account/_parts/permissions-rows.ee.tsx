// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import {
  getRoleDisplayName,
  type Permissions,
  PredefinedRoleNameSchema,
} from "@archestra/shared";
import { ChevronDown } from "lucide-react";
import { Fragment, type ReactNode, useId, useMemo, useState } from "react";
import { AccountRow, AccountRowMuted } from "@/app/account/_parts/account-rows";
import { RoleTypeIcon } from "@/components/role-type-icon";
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
 * The list, with a line under each row saying which role grants it, and
 * through which team when a team passes the role on.
 */
function PermissionsPanel({ permissions }: { permissions: Permissions }) {
  const { data: sources } = usePermissionSources();
  const provenance = useMemo(() => {
    if (!sources || sources.length === 0) return undefined;
    const byKey = new Map<string, Source[]>();
    for (const row of allPermissionRows) {
      const granting = sources
        .filter((source) => isGranted(source.permissions as Permissions, row))
        .map((source) => ({
          label: getRoleDisplayName(source.role),
          predefined: PredefinedRoleNameSchema.safeParse(source.role).success,
          team: source.team?.name ?? null,
        }));
      if (granting.length > 0) byKey.set(row.key, granting);
    }
    return (row: PermissionRow) => {
      const granting = byKey.get(row.key);
      return granting ? <SourceSentence sources={granting} /> : null;
    };
  }, [sources]);
  return (
    <PermissionList
      permissions={permissions}
      provenance={provenance}
      emptyMessage="Your roles and teams grant no permissions."
    />
  );
}

type Source = { label: string; predefined: boolean; team: string | null };

/**
 * "From Editor", "From Agent editor, through the Platform team",
 * "From Editor and Agent editor (through Platform)", and the Oxford comma
 * from three on. The plain sentence goes on the title for assistive tech.
 */
function SourceSentence({ sources }: { sources: Source[] }) {
  const single = sources.length === 1;
  const terms = sources.map((source) => (
    <span
      key={`${source.label}:${source.team ?? ""}`}
      className="inline whitespace-nowrap"
    >
      <RoleTypeIcon
        predefined={source.predefined}
        className="mr-1 inline-block size-3 align-[-2px]"
      />
      <span className="font-medium text-foreground/80">{source.label}</span>
      {source.team &&
        (single ? (
          <>
            , through the{" "}
            <span className="font-medium text-foreground/80">
              {source.team}
            </span>{" "}
            team
          </>
        ) : (
          <span className="text-muted-foreground/80">
            {" "}
            (through {source.team})
          </span>
        ))}
    </span>
  ));
  return (
    <span
      className="block text-[11px] leading-4 text-muted-foreground"
      title={plainSentence(sources)}
    >
      From {joinNodes(terms)}
    </span>
  );
}

/** Joins the way prose does: "a", "a and b", "a, b, and c". */
function joinNodes(nodes: ReactNode[]): ReactNode {
  if (nodes.length <= 1) return nodes;
  if (nodes.length === 2) {
    return (
      <>
        {nodes[0]} and {nodes[1]}
      </>
    );
  }
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: positional joiner over keyed nodes
    <Fragment key={index}>
      {node}
      {index < nodes.length - 2 && <span>, </span>}
      {index === nodes.length - 2 && <span>, and </span>}
    </Fragment>
  ));
}

function plainSentence(sources: Source[]): string {
  if (sources.length === 1) {
    const [source] = sources;
    return source.team
      ? `From ${source.label}, through the ${source.team} team`
      : `From ${source.label}`;
  }
  const terms = sources.map((source) =>
    source.team ? `${source.label} (through ${source.team})` : source.label,
  );
  if (terms.length === 2) return `From ${terms[0]} and ${terms[1]}`;
  return `From ${terms.slice(0, -1).join(", ")}, and ${terms.at(-1)}`;
}
