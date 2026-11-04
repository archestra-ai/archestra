// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
"use client";

import type { Permissions } from "@archestra/shared";
import { Check, Search } from "lucide-react";
import { Fragment, type ReactNode, useId, useState } from "react";
import {
  FilterBar,
  FilterSelect,
  filterSearchClass,
  useCompactFilters,
} from "@/components/filter-bar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils/tailwind";
import {
  allPermissionRows,
  canGrant,
  countGranted,
  filterPermissions,
  isGranted,
  type PermissionEntry,
  type PermissionFilter,
  type PermissionRow,
  permissionAreas,
  setRows,
  toggleRow,
} from "./permission-list-model.ee";

/**
 * Every permission a role can hold, a card per resource, filtered by a search
 * and by area. With `onChange` the rows are checkboxes and `grantable` says
 * which the author may grant; without it the list is read-only and opens on
 * the granted rows alone. `provenance` draws, under a granted row, where the
 * grant comes from ("From Editor and Reviewer (through Security)") when the
 * holder is a person rather than a role.
 */
export function PermissionList({
  permissions,
  onChange,
  grantable = {},
  provenance,
  emptyMessage = "This role grants no permissions.",
}: {
  permissions: Permissions;
  onChange?: (permissions: Permissions) => void;
  grantable?: Permissions;
  provenance?: (row: PermissionRow) => ReactNode;
  /** Shown in place of the list when nothing is granted. */
  emptyMessage?: ReactNode;
}) {
  const readOnly = !onChange;
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<PermissionFilter>(
    readOnly ? "granted" : "all",
  );
  const entries = filterPermissions({ permissions, query, filter });
  const granted = countGranted(permissions, allPermissionRows);
  const byArea = filter !== "all" && filter !== "granted";
  return (
    <div className="space-y-3">
      <PermissionFilterBar
        query={query}
        onQuery={setQuery}
        filter={filter}
        onFilter={setFilter}
        granted={granted}
        readOnly={readOnly}
      />
      <div className="space-y-3">
        {entries.map((entry, index) => (
          <Fragment key={entry.resource.resource}>
            {!byArea && entries[index - 1]?.area !== entry.area && (
              <h3
                className={cn(
                  "text-[11px] font-medium text-muted-foreground uppercase tracking-wide",
                  index > 0 && "pt-2",
                )}
              >
                {entry.area}
              </h3>
            )}
            <ResourceCard
              entry={entry}
              permissions={permissions}
              grantable={grantable}
              onChange={onChange}
              provenance={provenance}
            />
          </Fragment>
        ))}
        {entries.length === 0 && (
          <p className="rounded-lg border p-8 text-center text-sm text-muted-foreground">
            {readOnly && filter === "granted" && !query ? (
              <span>{emptyMessage}</span>
            ) : (
              <span>No permissions match.</span>
            )}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Search and the area filter on one row, as every filtered list draws them.
 * Below `lg` the chips give way to two selects in the funnel popover, with a
 * count on the funnel while a filter is on.
 */
function PermissionFilterBar({
  query,
  onQuery,
  filter,
  onFilter,
  granted,
  readOnly,
}: {
  query: string;
  onQuery: (value: string) => void;
  filter: PermissionFilter;
  onFilter: (filter: PermissionFilter) => void;
  granted: number;
  readOnly: boolean;
}) {
  const compact = useCompactFilters();
  const searchId = useId();
  const defaultFilter = readOnly ? "granted" : "all";
  const area = filter === "all" || filter === "granted" ? "all" : filter;
  const grantedLabel = readOnly ? "Granted" : "Selected";
  return (
    <FilterBar
      search={
        <div className={cn("relative", filterSearchClass)}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            aria-label="Search permissions"
            placeholder="Search permissions"
            value={query}
            onChange={(event) => onQuery(event.target.value)}
            className="h-8 pl-7.5 text-[13px]"
          />
        </div>
      }
      onClearFilters={
        filter !== defaultFilter ? () => onFilter(defaultFilter) : undefined
      }
    >
      {compact ? (
        <>
          <FilterSelect
            placeholder="Area"
            value={area}
            onValueChange={(value) => onFilter(value)}
            showSearch={false}
            items={[
              { value: "all", label: "All areas" },
              ...permissionAreas.map((group) => ({
                value: group.name,
                label: group.name,
              })),
            ]}
          />
          <FilterSelect
            placeholder="Show"
            inactiveValue="everything"
            value={filter === "granted" ? "granted" : "everything"}
            onValueChange={(value) =>
              onFilter(value === "granted" ? "granted" : "all")
            }
            showSearch={false}
            items={[
              { value: "everything", label: "Everything" },
              { value: "granted", label: `${grantedLabel} only (${granted})` },
            ]}
          />
        </>
      ) : (
        <fieldset className="flex min-w-0 flex-wrap items-center gap-1.5">
          <legend className="sr-only">Filter permissions</legend>
          <FilterChip active={filter === "all"} onClick={() => onFilter("all")}>
            All
          </FilterChip>
          <FilterChip
            active={filter === "granted"}
            onClick={() => onFilter("granted")}
          >
            {grantedLabel}
            <span className="ml-1 text-muted-foreground tabular-nums">
              {granted}
            </span>
          </FilterChip>
          <span className="mx-0.5 h-3.5 w-px bg-border" aria-hidden="true" />
          {permissionAreas.map((group) => (
            <FilterChip
              key={group.name}
              active={filter === group.name}
              onClick={() => onFilter(group.name)}
            >
              {group.name}
            </FilterChip>
          ))}
        </fieldset>
      )}
    </FilterBar>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-full font-normal",
        active && "border-primary/50 bg-primary/10 font-medium",
      )}
    >
      {children}
    </Button>
  );
}

/**
 * A resource: its select-all, name, a note where access is also granted on
 * each object, one line on what the resource is, then a row per permission.
 */
function ResourceCard({
  entry,
  permissions,
  grantable,
  onChange,
  provenance,
}: {
  entry: PermissionEntry;
  permissions: Permissions;
  grantable: Permissions;
  onChange?: (permissions: Permissions) => void;
  provenance?: (row: PermissionRow) => ReactNode;
}) {
  const { resource } = entry;
  const selected = countGranted(permissions, resource.rows);
  const total = resource.rows.length;
  return (
    <section
      aria-label={resource.label}
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex items-start gap-2.5 border-b bg-muted/50 px-3 py-2 text-[13px]">
        {onChange && (
          <Checkbox
            aria-label={`${resource.label}: all`}
            className="mt-0.5"
            checked={
              selected === 0
                ? false
                : selected === total
                  ? true
                  : "indeterminate"
            }
            disabled={!resource.rows.some((row) => canGrant(grantable, row))}
            onCheckedChange={(checked) =>
              onChange(
                setRows({
                  permissions,
                  rows: resource.rows,
                  grantable,
                  granted: checked === true,
                }),
              )
            }
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="font-medium">{resource.label}</span>
          <p className="text-xs text-muted-foreground">
            {resource.description}
          </p>
        </div>
        <span className="text-xs text-muted-foreground tabular-nums">
          {selected}/{total}
        </span>
      </div>
      <div className="py-0.5">
        {entry.rows.map((row) => (
          <PermissionRowItem
            key={row.key}
            row={row}
            granted={isGranted(permissions, row)}
            // A grant the author cannot give stays as it is: an existing one
            // can still be revoked, a missing one cannot be added.
            disabled={
              !!onChange &&
              !canGrant(grantable, row) &&
              !isGranted(permissions, row)
            }
            onToggle={
              onChange ? () => onChange(toggleRow(permissions, row)) : undefined
            }
            provenance={
              provenance && isGranted(permissions, row) ? provenance(row) : null
            }
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One permission on one line: the control, its label, what it allows, and
 * its key; where it comes from, when that is known, sits on a second line.
 * On a phone the line stacks, and the key moves under the text so the
 * description keeps the row's width.
 */
function PermissionRowItem({
  row,
  granted,
  disabled,
  onToggle,
  provenance,
}: {
  row: PermissionRow;
  granted: boolean;
  disabled: boolean;
  onToggle?: () => void;
  provenance: ReactNode;
}) {
  const id = useId();
  return (
    <Label
      htmlFor={id}
      className={cn(
        "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 px-3 py-1.5 font-normal transition-colors sm:min-h-8 sm:items-center",
        provenance ? "sm:py-1.5" : "sm:py-0",
        onToggle ? "cursor-pointer hover:bg-muted/40" : "cursor-default",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="mt-0.5 sm:mt-0">
        {onToggle ? (
          <Checkbox
            id={id}
            aria-label={row.label}
            checked={granted}
            disabled={disabled}
            onCheckedChange={onToggle}
          />
        ) : (
          <span className="flex size-4 items-center justify-center">
            {granted ? (
              <Check className="size-3.5 text-primary" aria-hidden="true" />
            ) : (
              <span
                className="size-1.5 rounded-full bg-muted-foreground/30"
                aria-hidden="true"
              />
            )}
            <span className="sr-only">
              {granted ? "Granted" : "Not granted"}
            </span>
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex min-w-0 flex-col sm:flex-row sm:items-baseline sm:gap-2">
          <span className="shrink-0 text-[13px] font-medium">{row.label}</span>
          <span className="min-w-0 text-xs text-muted-foreground sm:truncate">
            {row.description}
          </span>
          <code className="mt-1 font-mono text-[11px] text-muted-foreground/60 sm:hidden">
            {row.key}
          </code>
        </span>
        {provenance && (
          <span className="mt-0.5 block min-w-0">{provenance}</span>
        )}
      </span>
      <code className="hidden h-5 shrink-0 items-center rounded border border-border/50 bg-muted px-1.5 font-mono text-[11px] text-muted-foreground sm:inline-flex">
        {row.key}
      </code>
    </Label>
  );
}
