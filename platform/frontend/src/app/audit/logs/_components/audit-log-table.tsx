"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { ShieldBan, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  useCompactFilters,
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
  useAuditLogs,
} from "@/lib/audit-log/audit-log.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { AuditActorCell } from "./audit-actor-cell";
import { AuditActorFilter } from "./audit-actor-filter";
import {
  AuditEventCell,
  AuditStatusCell,
  AuditTimeCell,
} from "./audit-event-cells";
import { AuditEventFilter } from "./audit-event-filter";
import { findAuditEventEntry } from "./audit-event-taxonomy";
import {
  ALL_ACTIONS,
  ALL_ACTOR_TYPES,
  ALL_OUTCOMES,
  OUTCOME_LABEL,
} from "./audit-log-action-labels";
import { AuditLogDetailDrawer } from "./audit-log-detail-drawer";
import { AuditResourceFilter } from "./audit-resource-filter";

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
  const searchFromUrl = searchParams.get("search");

  const compactFilters = useCompactFilters();
  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  // Free-text search was removed from this page; scrub it from old links.
  useEffect(() => {
    if (!searchFromUrl) return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [pathname, router, searchFromUrl, searchParams]);
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
      // A cursor belongs to the listing it was issued for.
      if (!("cursor" in updates)) {
        params.delete("cursor");
        params.delete("page");
      }
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
        updateUrlParams({ startDate, endDate });
      },
      [updateUrlParams],
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

  const { data: canSeeAllAuditLogs } = useHasPermissions({
    auditLog: ["admin"],
  });
  const eventEntry = findAuditEventEntry({ action, resourceType });

  const rows = response?.data ?? [];
  const paginationMeta = response?.pagination;

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
        id: "status",
        header: () => <div className="text-right">Status</div>,
        size: 120,
        minSize: 108,
        cell: ({ row }) => <AuditStatusCell event={row.original} />,
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
        >
          <AuditEventFilter
            action={action}
            resourceType={resourceType}
            compact={compactFilters}
            onChange={(next) => updateUrlParams(next)}
          />
          <AuditActorFilter
            actorId={actorId}
            actorType={actorType}
            canPickPrincipals={!!canSeeAllAuditLogs}
            compact={compactFilters}
            onChange={(next) => updateUrlParams(next)}
          />
          <AuditResourceFilter
            resourceId={resourceId}
            resourceTypes={eventEntry?.resourceTypes}
            compact={compactFilters}
            onChange={(next) => updateUrlParams({ resourceId: next })}
          />
          <FilterSelect
            value={outcome ?? ALL_VALUE}
            onValueChange={(value) =>
              updateUrlParams({ outcome: value === ALL_VALUE ? null : value })
            }
            placeholder="Filter by outcome"
            items={OUTCOME_ITEMS}
            showSearch={false}
            inactiveValue={ALL_VALUE}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable<AuditLogRow, unknown>
        columns={columns}
        fixedWidthColumnIds={["actor", "status", "createdAt"]}
        flexibleColumnIds={["resource"]}
        data={rows}
        hideSelectedCount
        cursorPagination={cursorPagination.tableState(paginationMeta)}
        manualPagination
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyMessage="No audit events recorded yet. Administrative actions will appear here as they happen."
        filteredEmptyMessage="No audit events match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => openEventDialog(row as AuditLog)}
      />

      <AuditLogDetailDrawer
        event={selectedEvent}
        shareUrl={eventShareUrl}
        onClose={closeEventDialog}
        events={rows}
        onOpenEvent={openEventDialog}
      />
    </div>
  );
}

// === Internal helpers

/** Outcomes with the same glyphs the Status column shows. */
const OUTCOME_ITEMS = [
  { value: ALL_VALUE, label: "All outcomes" },
  ...ALL_OUTCOMES.map((outcome) => {
    const Icon = outcome === "denied" ? ShieldBan : X;
    return {
      value: outcome,
      label: OUTCOME_LABEL[outcome],
      content: (
        <span className="flex min-w-0 items-center gap-2">
          <span
            aria-hidden
            className="flex size-3.5 shrink-0 items-center justify-center"
          >
            {outcome === "success" ? (
              <span className="size-1.5 rounded-full bg-emerald-500" />
            ) : (
              <Icon className="size-3.5 text-destructive" />
            )}
          </span>
          <span className="truncate">{OUTCOME_LABEL[outcome]}</span>
        </span>
      ),
    };
  }),
];
