"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { useEffect, useMemo, useRef, useState } from "react";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type AuditEventListItem,
  useAuditEvents,
} from "@/lib/audit-event.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { formatDate } from "@/lib/utils";

export default function AuditLogPageClient() {
  const { searchParams, pageIndex, pageSize, offset, updateQueryParams } =
    useDataTableQueryParams({
      defaultPageSize: DEFAULT_TABLE_LIMIT,
    });

  const [tailEnabled, setTailEnabled] = useState(true);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [newEventsCount, setNewEventsCount] = useState(0);
  const newestEventIdRef = useRef<string | null>(null);

  const actorUserIdFromUrl = searchParams.get("actorUserId");
  const actionFromUrl = searchParams.get("action");
  const resourceTypeFromUrl = searchParams.get("resourceType");
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");

  const isFirstPage = pageIndex === 0;

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: ({ startDate, endDate }) => {
      updateQueryParams({ startDate, endDate, page: "1" });
    },
  });

  const query = useMemo(
    () => ({
      limit: pageSize,
      offset,
      actorUserId: actorUserIdFromUrl || undefined,
      action: actionFromUrl || undefined,
      resourceType: resourceTypeFromUrl || undefined,
      from: dateTimePicker.startDateParam,
      to: dateTimePicker.endDateParam,
      search: searchFromUrl || undefined,
    }),
    [
      actionFromUrl,
      actorUserIdFromUrl,
      dateTimePicker.endDateParam,
      dateTimePicker.startDateParam,
      offset,
      pageSize,
      resourceTypeFromUrl,
      searchFromUrl,
    ],
  );

  const { data: response, isFetching } = useAuditEvents(query);

  const [streamRows, setStreamRows] = useState<AuditEventListItem[]>([]);
  const baseRows = response?.data ?? [];

  const rows = tailEnabled && isFirstPage ? streamRows : baseRows;
  const pagination = response?.pagination;
  const hasFilters =
    !!actorUserIdFromUrl ||
    !!actionFromUrl ||
    !!resourceTypeFromUrl ||
    dateTimePicker.startDate !== undefined ||
    !!searchFromUrl;

  const columns: ColumnDef<AuditEventListItem>[] = [
    {
      id: "createdAt",
      header: "Date",
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "actorUserId",
      header: "Actor",
      cell: ({ row }) =>
        row.original.actorUserId ? (
          <code className="text-xs">{row.original.actorUserId}</code>
        ) : (
          <span className="text-xs text-muted-foreground">System</span>
        ),
    },
    {
      id: "action",
      header: "Action",
      cell: ({ row }) => (
        <Badge variant="secondary" className="text-xs">
          {row.original.action}
        </Badge>
      ),
    },
    {
      id: "resourceType",
      header: "Resource",
      cell: ({ row }) => (
        <Badge variant="outline" className="text-xs">
          {row.original.resourceType}
        </Badge>
      ),
    },
    {
      id: "resourceId",
      header: "Resource ID",
      cell: ({ row }) =>
        row.original.resourceId ? (
          <code className="text-xs">{row.original.resourceId}</code>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "ipAddress",
      header: "IP",
      cell: ({ row }) =>
        row.original.ipAddress ? (
          <code className="text-xs">{row.original.ipAddress}</code>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    {
      id: "details",
      header: "",
      cell: ({ row }) => <AuditEventDetailsDialog event={row.original} />,
    },
  ];

  // Keep the stream list in sync with the latest first-page fetch.
  useEffect(() => {
    if (!tailEnabled || !isFirstPage) return;
    setStreamRows(baseRows);
    newestEventIdRef.current = baseRows[0]?.id ?? null;
    setNewEventsCount(0);
  }, [baseRows, isFirstPage, tailEnabled]);

  // SSE tail: only enabled for first page and when there are no filters
  const sseEnabled = tailEnabled && isFirstPage && !hasFilters && !paused;
  useEffect(() => {
    if (!sseEnabled) return;

    const after = new Date().toISOString();
    const source = new EventSource(
      `/api/audit-events/stream?after=${encodeURIComponent(after)}`,
    );

    const onAuditEvent = (messageEvent: MessageEvent<string>) => {
      const incoming = safeParseAuditEvent(messageEvent.data);
      if (!incoming) return;

      setStreamRows((current) =>
        mergeNewAuditEvent({
          current,
          incoming,
          max: pageSize,
        }),
      );

      // Track "new events" when auto-scroll is off
      if (!autoScroll) {
        setNewEventsCount((c) => c + 1);
      } else {
        newestEventIdRef.current = incoming.id;
        setNewEventsCount(0);
      }
    };

    source.addEventListener("auditEvent", onAuditEvent as EventListener);
    source.addEventListener("error", () => {
      // Browser will auto-retry. No-op.
    });

    return () => {
      source.close();
    };
  }, [autoScroll, pageSize, sseEnabled]);

  useEffect(() => {
    if (!autoScroll || paused || !tailEnabled) return;
    // In this table, newest entries are at the top, so “auto-scroll” means “keep at top”.
    window.scrollTo({ top: 0 });
  }, [autoScroll, paused, tailEnabled]);

  return (
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          objectNamePlural="events"
          searchFields={["action", "resource", "resource id", "ip"]}
          paramName="search"
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
        />

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={tailEnabled}
              onCheckedChange={(checked) => setTailEnabled(checked)}
            />
            <span className="text-muted-foreground">Tail</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={!paused}
              disabled={!tailEnabled}
              onCheckedChange={(checked) => setPaused(!checked)}
            />
            <span className="text-muted-foreground">Live</span>
          </div>

          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={autoScroll}
              disabled={!tailEnabled || paused}
              onCheckedChange={(checked) => setAutoScroll(checked)}
            />
            <span className="text-muted-foreground">Auto-scroll</span>
          </div>

          {newEventsCount > 0 && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setNewEventsCount(0);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
            >
              {newEventsCount} new
            </Button>
          )}
        </div>
      </TableFilters>

      <DataTable
        columns={columns}
        data={rows}
        hideSelectedCount
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: pagination?.total ?? 0,
        }}
        onPaginationChange={(newPagination) => {
          updateQueryParams({
            page: String(newPagination.pageIndex + 1),
            pageSize: String(newPagination.pageSize),
          });
        }}
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyMessage="No audit events yet."
        filteredEmptyMessage="No audit events match your filters."
        onClearFilters={() => {
          dateTimePicker.clearDateRange();
          updateQueryParams({
            actorUserId: null,
            action: null,
            resourceType: null,
            startDate: null,
            endDate: null,
            search: null,
            page: "1",
          });
        }}
      />
    </div>
  );
}

function AuditEventDetailsDialog(params: { event: AuditEventListItem }) {
  const { event } = params;
  const metadata = event.metadata ?? null;

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          Details
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Audit event</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div className="text-muted-foreground">Action</div>
            <div className="col-span-2 font-mono text-xs">{event.action}</div>

            <div className="text-muted-foreground">Resource</div>
            <div className="col-span-2 font-mono text-xs">
              {event.resourceType}
              {event.resourceId ? ` / ${event.resourceId}` : ""}
            </div>

            <div className="text-muted-foreground">Actor</div>
            <div className="col-span-2 font-mono text-xs">
              {event.actorUserId ?? "System"}
            </div>

            <div className="text-muted-foreground">IP</div>
            <div className="col-span-2 font-mono text-xs">
              {event.ipAddress ?? "—"}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Metadata</div>
            <pre className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
              {metadata ? JSON.stringify(metadata, null, 2) : "—"}
            </pre>
          </div>
        </div>

        <div className="flex justify-end">
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function mergeNewAuditEvent(params: {
  current: AuditEventListItem[];
  incoming: AuditEventListItem;
  max: number;
}) {
  const { current, incoming, max } = params;
  if (current.some((e) => e.id === incoming.id)) return current;
  return [incoming, ...current].slice(0, max);
}

function safeParseAuditEvent(raw: string): AuditEventListItem | null {
  try {
    const parsed = JSON.parse(raw) as AuditEventListItem;
    if (!parsed || typeof parsed !== "object") return null;
    if (!("id" in parsed) || typeof parsed.id !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}
