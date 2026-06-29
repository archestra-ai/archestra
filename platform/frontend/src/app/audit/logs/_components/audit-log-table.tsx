"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  type AuditActorType,
  type AuditEventName,
  type AuditLog,
  type AuditOutcome,
  useAuditLogs,
} from "@/lib/audit-log/audit-log.query";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useMembersPaginated } from "@/lib/member.query";
import { formatDate } from "@/lib/utils";
import {
  ACTION_BADGE_VARIANT,
  ACTOR_TYPE_LABEL,
  ALL_ACTIONS,
  ALL_ACTOR_TYPES,
  ALL_OUTCOMES,
  formatAction,
  formatResourceType,
  KNOWN_RESOURCE_TYPES,
  OUTCOME_BADGE_VARIANT,
  OUTCOME_LABEL,
} from "./audit-log-action-labels";
import { AuditLogDetailDialog } from "./audit-log-detail-dialog";

const ACTOR_FILTER_LIMIT = 100;
const ALL_VALUE = "all";

function SortIcon({ isSorted }: { isSorted: "asc" | "desc" | false }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
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
  const [selectedEvent, setSelectedEvent] = useState<AuditLog | null>(null);

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
    search: searchFromUrl ?? undefined,
  });

  const { data: membersResponse } = useMembersPaginated({
    limit: ACTOR_FILTER_LIMIT,
    offset: 0,
  });

  const rows = response?.data ?? [];
  const paginationMeta = response?.pagination;

  const memberOptions = useMemo(() => {
    const items =
      membersResponse?.data?.map((m) => ({
        value: m.userId,
        label: m.name || m.email || "Unknown",
        description: m.name ? m.email : undefined,
      })) ?? [];
    return [{ value: ALL_VALUE, label: "All actors" }, ...items];
  }, [membersResponse]);

  const actionOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All actions" },
      ...ALL_ACTIONS.map((a) => ({ value: a, label: formatAction(a) })),
    ],
    [],
  );

  const resourceOptions = useMemo(
    () => [
      { value: ALL_VALUE, label: "All resources" },
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

  const columns = useMemo<ColumnDef<AuditLog>[]>(
    () => [
      {
        id: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            When
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-mono text-xs">
            {formatDate({ date: row.original.createdAt })}
          </div>
        ),
      },
      {
        id: "actor",
        header: "Actor",
        cell: ({ row }) => {
          const { actorName, actorEmail } = row.original;
          const label = actorName ?? actorEmail ?? "Deleted user";
          return (
            <Badge variant="outline" className="text-xs">
              <User className="mr-1 h-3 w-3 shrink-0" />
              <TruncatedText message={label} maxLength={24} />
            </Badge>
          );
        },
      },
      {
        id: "action",
        header: "Action",
        cell: ({ row }) => (
          <Badge
            variant={ACTION_BADGE_VARIANT[row.original.action]}
            className="text-xs whitespace-nowrap"
          >
            {formatAction(row.original.action)}
          </Badge>
        ),
      },
      {
        id: "outcome",
        header: "Outcome",
        cell: ({ row }) => (
          <Badge
            variant={OUTCOME_BADGE_VARIANT[row.original.outcome]}
            className="text-xs"
          >
            {OUTCOME_LABEL[row.original.outcome]}
          </Badge>
        ),
      },
      {
        id: "resource",
        header: "Resource",
        cell: ({ row }) => {
          const { resourceType: rt } = row.original;
          if (!rt) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          return (
            <Badge variant="secondary" className="text-xs">
              {formatResourceType(rt)}
            </Badge>
          );
        },
      },
      {
        id: "where",
        header: "Where",
        cell: ({ row }) => {
          const { sourceIp, userAgent } = row.original;
          if (!sourceIp && !userAgent) {
            return <span className="text-xs text-muted-foreground">—</span>;
          }
          const ipDisplay = sourceIp ?? "—";
          if (!userAgent) {
            return (
              <code className="text-xs text-muted-foreground">{ipDisplay}</code>
            );
          }
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <code className="text-xs text-muted-foreground">
                  {ipDisplay}
                </code>
              </TooltipTrigger>
              <TooltipContent className="max-w-sm break-all">
                {userAgent}
              </TooltipContent>
            </Tooltip>
          );
        },
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
    <div className="space-y-4">
      <TableFilters>
        <SearchInput
          objectNamePlural="audit events"
          searchFields={["actor", "path", "resource"]}
          paramName="search"
        />
        <SearchableSelect
          value={action ?? ALL_VALUE}
          onValueChange={handleActionChange}
          placeholder="Filter by action"
          items={actionOptions}
          className="w-[180px]"
        />
        <SearchableSelect
          value={outcome ?? ALL_VALUE}
          onValueChange={handleOutcomeChange}
          placeholder="Filter by outcome"
          items={outcomeOptions}
          className="w-[160px]"
        />
        <SearchableSelect
          value={actorType ?? ALL_VALUE}
          onValueChange={handleActorTypeChange}
          placeholder="Filter by actor type"
          items={actorTypeOptions}
          className="w-[170px]"
        />
        <SearchableSelect
          value={resourceType ?? ALL_VALUE}
          onValueChange={handleResourceChange}
          placeholder="Filter by resource"
          items={resourceOptions}
          className="w-[200px]"
        />
        <SearchableSelect
          value={actorId ?? ALL_VALUE}
          onValueChange={handleActorChange}
          placeholder="Filter by actor"
          items={memberOptions}
          className="w-[220px]"
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
      </TableFilters>

      <DataTable
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
        filteredEmptyMessage="No audit events match your filters. Try adjusting your search."
        onClearFilters={clearFilters}
        onRowClick={(row) => setSelectedEvent(row)}
      />

      <AuditLogDetailDialog
        event={selectedEvent}
        onClose={() => setSelectedEvent(null)}
      />
    </div>
  );
}
