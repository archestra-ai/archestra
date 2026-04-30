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

const EMPTY_ROWS: AuditEventListItem[] = [];

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
  const baseRows = response?.data ?? EMPTY_ROWS;

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
        row.original.actorUserId || row.original.actor ? (
          <span className="text-xs">{getActorLabel(row.original)}</span>
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
      header: "Object",
      cell: ({ row }) => {
        const label = getResourceLabel(row.original);
        const id = row.original.resourceId;
        return (
          <div className="min-w-0">
            {label ? (
              <div className="truncate text-xs">{label}</div>
            ) : id ? (
              <code className="text-xs">{shortenId(id)}</code>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
            {id ? (
              <div className="truncate font-mono text-[10px] text-muted-foreground">
                {shortenId(id)}
              </div>
            ) : null}
          </div>
        );
      },
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
            <div className="col-span-2 text-xs">
              {event.actorUserId || event.actor
                ? getActorLabel(event)
                : "System"}
            </div>

            <div className="text-muted-foreground">IP</div>
            <div className="col-span-2 font-mono text-xs">
              {event.ipAddress ?? "—"}
            </div>
          </div>

          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Details</div>
            <div className="max-h-[50vh] overflow-auto rounded-md bg-muted p-3 text-xs">
              {renderAuditEventDetails(event, metadata)}
            </div>
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

function getActorLabel(event: AuditEventListItem): string {
  const actor = (event as AuditEventListItem & {
    actor?: { id: string; name: string; email: string; image?: string | null } | null;
  }).actor;

  if (actor?.name && actor?.email) return `${actor.name} (${actor.email})`;
  if (actor?.email) return actor.email;
  if (actor?.name) return actor.name;

  const id = event.actorUserId;
  if (!id) return "System";
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function getResourceLabel(event: AuditEventListItem): string | null {
  const metadata = event.metadata as Record<string, unknown> | null | undefined;
  if (!metadata) return null;

  // Common "name" pattern
  if (typeof metadata.name === "string" && metadata.name.trim().length > 0) {
    return metadata.name;
  }

  // Update events often store before/after
  const after = metadata.after as Record<string, unknown> | undefined;
  const before = metadata.before as Record<string, unknown> | undefined;
  const afterName = after && typeof after.name === "string" ? after.name : null;
  const beforeName =
    before && typeof before.name === "string" ? before.name : null;
  return afterName || beforeName || null;
}

function shortenId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function renderAuditEventDetails(
  event: AuditEventListItem,
  metadata: Record<string, unknown> | null,
) {
  const action = event.action;

  if (action === "http.mutation" && metadata) {
    const method = typeof metadata.method === "string" ? metadata.method : "HTTP";
    const url = typeof metadata.url === "string" ? metadata.url : "";
    const statusCode =
      typeof metadata.statusCode === "number" ? metadata.statusCode : null;
    return (
      <div className="space-y-1">
        <div className="font-mono">
          {method} {url}
          {statusCode ? ` → ${statusCode}` : ""}
        </div>
      </div>
    );
  }

  if (action === "team.create" && metadata && typeof metadata.name === "string") {
    return <div>Created team “{metadata.name}”.</div>;
  }

  if (action === "team.delete" && metadata && typeof metadata.name === "string") {
    return <div>Deleted team “{metadata.name}”.</div>;
  }

  if (action === "agent.create" && metadata && typeof metadata.name === "string") {
    const agentType =
      typeof metadata.agentType === "string" ? metadata.agentType : null;
    return (
      <div>
        Created agent “{metadata.name}”
        {agentType ? ` (${agentType})` : ""}.
      </div>
    );
  }

  if (action === "agent.delete" && metadata && typeof metadata.name === "string") {
    const agentType =
      typeof metadata.agentType === "string" ? metadata.agentType : null;
    return (
      <div>
        Deleted agent “{metadata.name}”
        {agentType ? ` (${agentType})` : ""}.
      </div>
    );
  }

  if (action === "team.update" && metadata) {
    const before = metadata.before as Record<string, unknown> | undefined;
    const after = metadata.after as Record<string, unknown> | undefined;
    if (before && after) {
      const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
      for (const key of Object.keys({ ...before, ...after })) {
        if (before[key] !== after[key]) {
          changes.push({ field: key, from: before[key], to: after[key] });
        }
      }
      if (changes.length > 0) {
        return (
          <div className="space-y-2">
            <div>Updated team:</div>
            <ul className="list-inside list-disc space-y-1">
              {changes.map((c) => (
                <li key={c.field}>
                  <span className="font-medium">{c.field}</span>:{" "}
                  <span className="font-mono">{stringifyValue(c.from)}</span> →{" "}
                  <span className="font-mono">{stringifyValue(c.to)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      }
    }
  }

  if (
    action === "agent.update" &&
    metadata &&
    typeof metadata.before === "object" &&
    typeof metadata.after === "object"
  ) {
    const before = metadata.before as Record<string, unknown>;
    const after = metadata.after as Record<string, unknown>;
    const changes: Array<{ field: string; from: unknown; to: unknown }> = [];
    for (const key of Object.keys({ ...before, ...after })) {
      if (before[key] !== after[key]) {
        changes.push({ field: key, from: before[key], to: after[key] });
      }
    }
    if (changes.length > 0) {
      return (
        <div className="space-y-2">
          <div>Updated agent:</div>
          <ul className="list-inside list-disc space-y-1">
            {changes.map((c) => (
              <li key={c.field}>
                <span className="font-medium">{c.field}</span>:{" "}
                <span className="font-mono">{stringifyValue(c.from)}</span> →{" "}
                <span className="font-mono">{stringifyValue(c.to)}</span>
              </li>
            ))}
          </ul>
        </div>
      );
    }
  }

  if (
    action === "mcpServer.install" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Installed MCP server “{metadata.name}”.</div>;
  }

  if (
    action === "mcpServer.uninstall" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Uninstalled MCP server “{metadata.name}”.</div>;
  }

  if (
    action === "mcpServer.reinstall" &&
    metadata &&
    typeof metadata.name === "string"
  ) {
    return <div>Reinstalled MCP server “{metadata.name}”.</div>;
  }

  return (
    <pre className="whitespace-pre-wrap">
      {metadata ? JSON.stringify(metadata, null, 2) : "—"}
    </pre>
  );
}

function stringifyValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
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
