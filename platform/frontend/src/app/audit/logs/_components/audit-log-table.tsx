"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type AuditActorType,
  type AuditEventName,
  type AuditLog,
  type AuditOutcome,
  useAuditLog,
  useAuditLogResourceSearch,
  useAuditLogs,
} from "@/lib/audit-log/audit-log.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useMemberSearch } from "@/lib/member.query";
import { AuditActorCell } from "./audit-actor-cell";
import {
  AuditEventCell,
  AuditRequestCell,
  AuditTimeCell,
} from "./audit-event-cells";
import {
  ACTOR_TYPE_LABEL,
  ALL_ACTIONS,
  ALL_ACTOR_TYPES,
  ALL_OUTCOMES,
  formatAction,
  formatResourceType,
  KNOWN_RESOURCE_TYPES,
  OUTCOME_LABEL,
} from "./audit-log-action-labels";
import { AuditLogDetailDialog } from "./audit-log-detail-dialog";

const ACTOR_FILTER_LIMIT = 100;
const ALL_VALUE = "all";

// TS7 (tsgo) trips instantiating ColumnDef over AuditLog because `action` is a
// large string-literal union, failing with a spurious "two unrelated ColumnDef
// types" error under CI's compiler. The table only displays `action`, so widen
// it to string for the row/column types; the typed union is still enforced on
// ACTION_LABEL and the filter.
type AuditLogRow = Omit<AuditLog, "action"> & { action: string };

export function AuditLogTable() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
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
  const cursorFromUrl = searchParams.get("cursor");
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search");

  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  useEffect(() => {
    if (!cursorFromUrl && !pageFromUrl && !pageSizeFromUrl && !searchFromUrl)
      return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("cursor");
    params.delete("page");
    params.delete("pageSize");
    params.delete("search");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [
    cursorFromUrl,
    pageFromUrl,
    pageSizeFromUrl,
    pathname,
    router,
    searchFromUrl,
    searchParams,
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
        cursorPagination.goNewest();
        updateUrlParams({ startDate, endDate });
      },
      [cursorPagination.goNewest, updateUrlParams],
    ),
  });
  // Every log page keeps its time range in the header's top-right corner.
  const timeRangePicker = useMemo(
    () => (
      <TimeRangePicker
        value={dateTimePicker.range}
        onChange={dateTimePicker.setRange}
        onClear={dateTimePicker.clearDateRange}
      />
    ),
    [
      dateTimePicker.range,
      dateTimePicker.setRange,
      dateTimePicker.clearDateRange,
    ],
  );
  useLogsHeaderAction(timeRangePicker);

  const handleActionChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ action: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleResourceChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ resourceType: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleActorChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ actorId: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleEntityChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ resourceId: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleOutcomeChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ outcome: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleActorTypeChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ actorType: value === ALL_VALUE ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

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
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    actorId,
    action,
    outcome,
    actorType,
    resourceType,
    resourceId,
  });

  // The actor and resource pickers search on the server and load their
  // options only while open, so a closed picker does not refetch on window
  // focus. A selection from the URL still loads its label.
  const [actorPickerOpen, setActorPickerOpen] = useState(false);
  const [resourcePickerOpen, setResourcePickerOpen] = useState(false);
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
    enabled: !!canSeeAllAuditLogs && (actorPickerOpen || !!actorId),
  });
  const resourceSearch = useAuditLogResourceSearch({
    enabled: resourcePickerOpen,
    selectedResourceId: resourceId,
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
    const { options, selected } = resourceSearch;
    const listed =
      selected && !options.some((o) => o.resourceId === selected.resourceId)
        ? [selected, ...options]
        : options;
    return listed.map((option) => ({
      value: option.resourceId,
      label: option.name,
      // Single line per option: long machine names truncate with an ellipsis
      // (full name in the hover title) so the popover stays scannable. The
      // type goes into `description`, rendered as a subtitle.
      content: (
        <span className="block truncate" title={option.name}>
          {option.name}
        </span>
      ),
      description: formatResourceType(option.resourceType),
    }));
  }, [resourceSearch]);

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
        id: "resource",
        header: "Event",
        size: 360,
        minSize: 280,
        cell: ({ row }) => <AuditEventCell event={row.original} />,
      },
      {
        id: "actor",
        header: "Actor",
        size: 272,
        minSize: 230,
        cell: ({ row }) => <AuditActorCell event={row.original} />,
      },
      {
        id: "request",
        header: () => <div className="text-right">Request</div>,
        size: 112,
        minSize: 100,
        cell: ({ row }) => <AuditRequestCell event={row.original} />,
      },
      {
        id: "createdAt",
        header: () => <div className="text-right">Time</div>,
        size: 128,
        minSize: 120,
        cell: ({ row }) => <AuditTimeCell event={row.original} />,
      },
    ],
    [],
  );

  const hasFilters =
    action !== undefined ||
    outcome !== undefined ||
    actorType !== undefined ||
    resourceType !== undefined ||
    resourceId !== undefined ||
    actorId !== undefined ||
    dateTimePicker.startDate !== undefined;

  const clearFilters = useCallback(() => {
    cursorPagination.goNewest();
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
      cursor: null,
      page: null,
      pageSize: null,
    });
  }, [cursorPagination.goNewest, dateTimePicker, updateUrlParams]);

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
                  pinnedItems={[{ value: ALL_VALUE, label: "All resources" }]}
                  onSearchQueryChange={resourceSearch.onSearchQueryChange}
                  onOpenChange={setResourcePickerOpen}
                  emptyMessage={
                    resourceSearch.isSearching
                      ? "Searching…"
                      : "No matching resources found."
                  }
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
                        onOpenChange={setActorPickerOpen}
                        emptyMessage={actorEmptyMessage}
                        inactiveValue={ALL_VALUE}
                      />
                    ),
                  },
                ]
              : []),
          ]}
        >
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
        </FilterBar>
      </CollectionFilters>

      <DataTable<AuditLogRow, unknown>
        columns={columns}
        fixedWidthColumnIds={["actor", "request", "createdAt"]}
        flexibleColumnIds={["resource"]}
        data={rows}
        hideSelectedCount
        cursorPagination={
          paginationMeta
            ? {
                pageIndex: cursorPagination.pageIndex,
                pageSize: cursorPagination.pageSize,
                hasNext: paginationMeta.hasNext,
                canGoNewer: cursorPagination.canGoNewer,
                onPageSizeChange: cursorPagination.setPageSize,
                onNewer: cursorPagination.goNewer,
                onOlder: () =>
                  cursorPagination.goOlder(paginationMeta.nextCursor),
              }
            : undefined
        }
        manualPagination
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
