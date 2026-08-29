"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useProfilesPaginated } from "@/lib/agent.query";
import { useApps } from "@/lib/app.query";
import {
  type AuditActorType,
  type AuditEventName,
  type AuditLog,
  type AuditOutcome,
  useAuditLog,
  useAuditLogs,
} from "@/lib/audit-log/audit-log.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useEnvironments } from "@/lib/environment.query";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import { useMemberSearch } from "@/lib/member.query";
import { useRolesPaginated } from "@/lib/role.query";
import { useSkillsPaginated } from "@/lib/skills/skill.query";
import { useTeams } from "@/lib/teams/team.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils";
import {
  ACTOR_TYPE_LABEL,
  ALL_ACTIONS,
  ALL_ACTOR_TYPES,
  ALL_OUTCOMES,
  formatAction,
  formatResourceType,
  KNOWN_RESOURCE_TYPES,
  OUTCOME_BADGE_VARIANT,
  OUTCOME_LABEL,
  resourceDisplayName,
} from "./audit-log-action-labels";
import { AuditLogDetailDialog } from "./audit-log-detail-dialog";

const ACTOR_FILTER_LIMIT = 100;
const ENTITY_FILTER_LIMIT = 100;
const RESOURCE_NAME_TRUNCATE_LENGTH = 64;
const ALL_VALUE = "all";

// The high-signal types whose names render in the Resource column and whose
// entities populate the "Filter by resource" picker. Every other type keeps a
// bare type label in the list; its full identity lives in the detail dialog.
const LIST_NAME_RESOURCE_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "app",
  "environment",
  "mcpServer",
  "role",
  "skill",
  "team",
]);

// TS7 (tsgo) trips instantiating ColumnDef over AuditLog because `action` is a
// large string-literal union, failing with a spurious "two unrelated ColumnDef
// types" error under CI's compiler. The table only displays `action`, so widen
// it to string for the row/column types; the typed union is still enforced on
// ACTION_LABEL and the filter.
type AuditLogRow = Omit<AuditLog, "action"> & { action: string };

function SortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

export function AuditLogTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");
  const actionFromUrl = (searchParams.get("action") ?? ALL_VALUE) as
    | typeof ALL_VALUE
    | AuditEventName;
  const resourceTypeFromUrl = searchParams.get("resourceType") ?? ALL_VALUE;
  const resourceIdFromUrl = searchParams.get("resourceId") ?? ALL_VALUE;
  const actorFromUrl = searchParams.get("actorId") ?? ALL_VALUE;
  const outcomeFromUrl = (searchParams.get("outcome") ?? ALL_VALUE) as
    | typeof ALL_VALUE
    | AuditOutcome;
  const actorTypeFromUrl = (searchParams.get("actorType") ?? ALL_VALUE) as
    | typeof ALL_VALUE
    | AuditActorType;

  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const eventId = searchParams.get("event");
  const { data: eventFromUrl } = useAuditLog(eventId ?? undefined);
  const {
    entity: selectedEvent,
    open: openEventDialog,
    close: closeEventDialog,
  } = useDialogUrlParam({
    paramName: "event",
    entityFromUrl: eventFromUrl ?? null,
  });

  // Shareable URL for the open event: force `event` onto the current params so
  // the link is complete even before router.replace lands (or after a back nav
  // strips it while the dialog stays open), origin-prefixed for a full URL.
  const eventShareUrl = useMemo(() => {
    if (typeof window === "undefined" || !selectedEvent) return "";
    const params = new URLSearchParams(searchParams.toString());
    params.set("event", selectedEvent.id);
    return `${window.location.origin}${pathname}?${params.toString()}`;
  }, [selectedEvent, pathname, searchParams]);

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      }
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        setPagination((prev) => ({ ...prev, pageIndex: 0 }));
        updateUrlParams({ startDate, endDate });
      },
      [updateUrlParams],
    ),
  });

  const handleActionChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ action: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const handleResourceChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ resourceType: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const handleActorChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ actorId: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const handleEntityChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ resourceId: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const handleOutcomeChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ outcome: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const handleActorTypeChange = useCallback(
    (value: string) => {
      setPagination((prev) => ({ ...prev, pageIndex: 0 }));
      updateUrlParams({ actorType: value === ALL_VALUE ? null : value });
    },
    [updateUrlParams],
  );

  const sortDirection = sorting[0]?.desc === false ? "asc" : "desc";

  const action = (ALL_ACTIONS as readonly string[]).includes(actionFromUrl)
    ? (actionFromUrl as AuditEventName)
    : undefined;
  const resourceType =
    resourceTypeFromUrl === ALL_VALUE ? undefined : resourceTypeFromUrl;
  const resourceId =
    resourceIdFromUrl === ALL_VALUE ? undefined : resourceIdFromUrl;
  const actorId = actorFromUrl === ALL_VALUE ? undefined : actorFromUrl;
  const outcome = (ALL_OUTCOMES as readonly string[]).includes(outcomeFromUrl)
    ? (outcomeFromUrl as AuditOutcome)
    : undefined;
  const actorType = (ALL_ACTOR_TYPES as readonly string[]).includes(
    actorTypeFromUrl,
  )
    ? (actorTypeFromUrl as AuditActorType)
    : undefined;

  const {
    data: response,
    isFetching,
    isLoadingError: isAuditLogsLoadError,
    refetch: refetchAuditLogs,
  } = useAuditLogs({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortDirection,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    actorId,
    action,
    outcome,
    actorType,
    resourceType,
    resourceId,
    search: searchFromUrl ?? undefined,
  });

  // Server-side search rather than a client filter over the first N members:
  // an org larger than one page would otherwise silently hide every actor
  // whose name sorts past the cut-off.
  const { data: canSeeAllAuditLogs } = useHasPermissions({
    auditLog: ["admin"],
  });
  const {
    users: actorUsers,
    onSearchQueryChange: onActorSearchChange,
    emptyMessage: actorEmptyMessage,
  } = useMemberSearch({
    limit: ACTOR_FILTER_LIMIT,
    selectedUserIds: actorId ? [actorId] : [],
  });

  // Two lifecycle buckets: agents are soft-deleted, so a deleted agent's
  // history stays reachable through the picker (the audit page is admin-only,
  // which is also what the deleted bucket requires).
  const { data: activeAgentsResponse } = useProfilesPaginated({
    limit: ENTITY_FILTER_LIMIT,
    offset: 0,
    sortBy: "name",
    sortDirection: "asc",
    status: "active",
  });
  const { data: deletedAgentsResponse } = useProfilesPaginated({
    limit: ENTITY_FILTER_LIMIT,
    offset: 0,
    sortBy: "name",
    sortDirection: "asc",
    status: "deleted",
  });

  // The remaining LIST_NAME_RESOURCE_TYPES entities for the entity picker.
  const { data: mcpServers } = useMcpServers();
  const { data: teams } = useTeams();
  const { data: rolesResponse } = useRolesPaginated({
    limit: ENTITY_FILTER_LIMIT,
    offset: 0,
  });
  const { data: environmentList } = useEnvironments();
  const { data: appsResponse } = useApps({
    limit: ENTITY_FILTER_LIMIT,
    offset: 0,
  });
  const { data: skillsResponse } = useSkillsPaginated({
    limit: ENTITY_FILTER_LIMIT,
    offset: 0,
  });

  const rows = response?.data ?? [];
  const paginationMeta = response?.pagination;

  const memberOptions = useMemo(
    () =>
      actorUsers.map((user) => ({
        value: user.userId,
        label: user.name || user.email || "Unknown",
        description: user.name ? (user.email ?? undefined) : undefined,
      })),
    [actorUsers],
  );

  const entityOptions = useMemo(() => {
    // The type goes into `description`: SearchableSelect renders it as a
    // subtitle and matches it in search, so typing "team" finds all teams.
    const toOptions = (
      items: Array<{ id: string; name: string }> | undefined,
      resourceType: string,
    ) =>
      (items ?? [])
        .map((item) => ({
          value: item.id,
          label: item.name,
          // Single line per option: long machine names truncate with an
          // ellipsis (full name in the hover title, and search still matches
          // the full label) so the popover stays scannable.
          content: (
            <span className="block truncate" title={item.name}>
              {item.name}
            </span>
          ),
          description: formatResourceType(resourceType),
        }))
        .sort((a, b) => a.label.localeCompare(b.label));

    const deletedAgents = toOptions(deletedAgentsResponse?.data, "agent").map(
      (option) => ({ ...option, description: "Agent (deleted)" }),
    );
    // External catalog apps carry no id (and are not audited) — only owned
    // apps can be picked.
    const ownedApps = appsResponse?.data?.filter(
      (app) => app.source === "owned",
    );
    return [
      { value: ALL_VALUE, label: "All resources" },
      ...toOptions(activeAgentsResponse?.data, "agent"),
      ...deletedAgents,
      ...toOptions(mcpServers, "mcpServer"),
      ...toOptions(teams, "team"),
      ...toOptions(rolesResponse?.data, "role"),
      ...toOptions(environmentList?.environments, "environment"),
      ...toOptions(ownedApps, "app"),
      ...toOptions(skillsResponse?.data, "skill"),
    ];
  }, [
    activeAgentsResponse,
    deletedAgentsResponse,
    mcpServers,
    teams,
    rolesResponse,
    environmentList,
    appsResponse,
    skillsResponse,
  ]);

  const actionOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All actions" },
      ...ALL_ACTIONS.map((a) => ({ value: a, label: formatAction(a) })),
    ],
    [],
  );

  const resourceOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All resource types" },
      ...KNOWN_RESOURCE_TYPES.map((r) => ({
        value: r,
        label: formatResourceType(r),
      })),
    ],
    [],
  );

  const outcomeOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All outcomes" },
      ...ALL_OUTCOMES.map((o) => ({ value: o, label: OUTCOME_LABEL[o] })),
    ],
    [],
  );

  const actorTypeOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All actor types" },
      ...ALL_ACTOR_TYPES.map((t) => ({
        value: t,
        label: ACTOR_TYPE_LABEL[t],
      })),
    ],
    [],
  );

  const columns = useMemo<ColumnDef<AuditLogRow>[]>(
    () => [
      {
        id: "activity",
        header: "Activity",
        size: 300,
        minSize: 240,
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">
              {formatAction(row.original.action)}
            </span>
            <Badge
              variant={OUTCOME_BADGE_VARIANT[row.original.outcome]}
              className="px-1.5 py-0 text-[10px]"
            >
              {OUTCOME_LABEL[row.original.outcome]}
            </Badge>
          </div>
        ),
      },
      {
        id: "actor",
        header: "Actor",
        size: 240,
        minSize: 190,
        cell: ({ row }) => {
          const {
            actorName,
            actorEmail,
            actorType,
            impersonatedBy,
            impersonatedByEmail,
          } = row.original;
          const label = actorName ?? actorEmail ?? "Deleted user";
          return (
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                <User className="size-3.5" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">{label}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {impersonatedBy
                    ? `via ${impersonatedByEmail ?? "deleted user"}`
                    : ACTOR_TYPE_LABEL[actorType]}
                </div>
              </div>
            </div>
          );
        },
      },
      {
        id: "resource",
        header: "Resource",
        size: 280,
        minSize: 220,
        cell: ({ row }) => {
          const { resourceType } = row.original;
          const name =
            resourceType && LIST_NAME_RESOURCE_TYPES.has(resourceType)
              ? resourceDisplayName(row.original)
              : null;
          if (!resourceType && !name) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const displayName =
            name && name.length > RESOURCE_NAME_TRUNCATE_LENGTH
              ? `${name.slice(0, RESOURCE_NAME_TRUNCATE_LENGTH)}…`
              : name;
          return (
            <div className="min-w-0">
              <div
                className="truncate text-sm font-medium"
                title={name ?? undefined}
              >
                {displayName ?? formatResourceType(resourceType ?? "")}
              </div>
              {name && resourceType ? (
                <div className="truncate text-xs text-muted-foreground">
                  {formatResourceType(resourceType)}
                </div>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Time
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        size: 190,
        minSize: 175,
        cell: ({ row }) => (
          <div className="min-w-0">
            <div className="text-sm">
              {formatRelativeTimeFromNow(row.original.createdAt)}
            </div>
            <div className="truncate font-mono text-[11px] text-muted-foreground">
              {formatDate({
                date: row.original.createdAt,
                dateFormat: "MMM d, yyyy · HH:mm:ss",
              })}
            </div>
          </div>
        ),
      },
    ],
    [],
  );

  const hasFilters =
    !!searchFromUrl ||
    action !== undefined ||
    outcome !== undefined ||
    actorType !== undefined ||
    resourceType !== undefined ||
    resourceId !== undefined ||
    actorId !== undefined ||
    dateTimePicker.startDate !== undefined;

  const clearFilters = useCallback(() => {
    setPagination((prev) => ({ ...prev, pageIndex: 0 }));
    dateTimePicker.clearDateRange();
    updateUrlParams({
      search: null,
      action: null,
      outcome: null,
      actorType: null,
      resourceType: null,
      resourceId: null,
      actorId: null,
      startDate: null,
      endDate: null,
      page: "1",
    });
  }, [dateTimePicker, updateUrlParams]);

  if (isAuditLogsLoadError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load audit events"
          onRetry={() => refetchAuditLogs()}
        />
      </div>
    );
  }

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          leading
          onClearFilters={hasFilters ? clearFilters : undefined}
          // Action, outcome and the date range are what people reach for on this
          // trail day to day; the four identity/resource pickers only matter once
          // you are chasing a specific thing, so they start tucked away.
          moreFilters={[
            {
              key: "actorType",
              label: "Actor type",
              active: !!actorType,
              control: (
                <FilterSelect
                  value={actorType ?? ALL_VALUE}
                  onValueChange={handleActorTypeChange}
                  placeholder="Filter by actor type"
                  items={actorTypeOptions}
                  inactiveValue={ALL_VALUE}
                />
              ),
            },
            {
              key: "resourceType",
              label: "Resource type",
              active: !!resourceType,
              control: (
                <FilterSelect
                  value={resourceType ?? ALL_VALUE}
                  onValueChange={handleResourceChange}
                  placeholder="Filter by resource type"
                  items={resourceOptions}
                  inactiveValue={ALL_VALUE}
                />
              ),
            },
            {
              key: "resourceId",
              label: "Resource",
              active: !!resourceId,
              control: (
                <FilterSelect
                  value={resourceId ?? ALL_VALUE}
                  onValueChange={handleEntityChange}
                  placeholder="Filter by resource"
                  items={entityOptions}
                  inactiveValue={ALL_VALUE}
                />
              ),
            },
            // Without auditLog:admin the server scopes the trail to the caller's
            // own actions, so an actor filter would be pointless.
            ...(canSeeAllAuditLogs
              ? [
                  {
                    key: "actorId",
                    label: "Actor",
                    active: !!actorId,
                    control: (
                      <FilterSelect
                        value={actorId ?? ALL_VALUE}
                        onValueChange={handleActorChange}
                        placeholder="Filter by actor"
                        items={memberOptions}
                        pinnedItems={[
                          { value: ALL_VALUE, label: "All actors" },
                        ]}
                        onSearchQueryChange={onActorSearchChange}
                        emptyMessage={actorEmptyMessage}
                        inactiveValue={ALL_VALUE}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        >
          <SearchInput
            isLoading={isFetching}
            objectNamePlural="audit events"
            searchFields={["actor", "path", "resource"]}
            paramName="search"
            className={filterSearchClass}
          />
          <FilterSelect
            value={action ?? ALL_VALUE}
            onValueChange={handleActionChange}
            placeholder="Filter by action"
            items={actionOptions}
            inactiveValue={ALL_VALUE}
          />
          <FilterSelect
            value={outcome ?? ALL_VALUE}
            onValueChange={handleOutcomeChange}
            placeholder="Filter by outcome"
            items={outcomeOptions}
            inactiveValue={ALL_VALUE}
          />
          <DateTimeRangePicker
            startDate={dateTimePicker.startDate}
            endDate={dateTimePicker.endDate}
            isDialogOpen={dateTimePicker.isDateDialogOpen}
            tempStartDate={dateTimePicker.tempStartDate}
            tempEndDate={dateTimePicker.tempEndDate}
            displayText={dateTimePicker.getDateRangeDisplay()}
            onDialogOpenChange={dateTimePicker.setIsDateDialogOpen}
            onTempStartDateChange={dateTimePicker.setTempStartDate}
            onTempEndDateChange={dateTimePicker.setTempEndDate}
            onOpenDialog={dateTimePicker.openDateDialog}
            onApply={dateTimePicker.handleApplyDateRange}
            className={filterControlClass({
              active: dateTimePicker.startDate !== undefined,
            })}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable<AuditLogRow, unknown>
        columns={columns}
        data={rows}
        hideSelectedCount
        pagination={
          paginationMeta
            ? {
                pageIndex: pagination.pageIndex,
                pageSize: pagination.pageSize,
                total: paginationMeta.total,
              }
            : undefined
        }
        manualPagination
        onPaginationChange={setPagination}
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyMessage="No audit events recorded yet. Administrative actions will appear here as they happen."
        filteredEmptyMessage="No audit events match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => openEventDialog(row as AuditLog)}
      />

      <AuditLogDetailDialog
        event={selectedEvent}
        shareUrl={eventShareUrl}
        onClose={closeEventDialog}
      />
    </div>
  );
}
