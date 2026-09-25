"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { Download, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import {
  type ExternalConsultFilters,
  type ExternalConsultOutcome,
  useExportExternalConsults,
  useExternalConsults,
} from "@/lib/openappa/external-consults.query";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils";
import { ConsultDetailSheet } from "./consult-detail-sheet";
import { type ConsultView, toConsultView } from "./consult-details";
import {
  ALL_OUTCOMES,
  ConsultOutcomeBadge,
  OUTCOME_LABEL,
} from "./consult-outcome-badge";

export function ConsultsTable() {
  const { searchParams, updateQueryParams: updateUrlParams } =
    useDataTableQueryParams();
  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  const [selected, setSelected] = useState<ConsultView | null>(null);

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl: searchParams.get("startDate"),
    endDateFromUrl: searchParams.get("endDate"),
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        cursorPagination.goNewest();
        updateUrlParams({ startDate, endDate });
      },
      [cursorPagination.goNewest, updateUrlParams],
    ),
  });

  const filters: ExternalConsultFilters = {
    externalName: searchParams.get("externalName") || undefined,
    sessionId: searchParams.get("sessionId") || undefined,
    outcome: parseOutcome(searchParams.get("outcome")),
    from: dateTimePicker.startDateParam,
    to: dateTimePicker.endDateParam,
  };

  const {
    data: response,
    isFetching,
    isLoadingError,
    refetch,
  } = useExternalConsults({
    filters,
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
  });
  const exportConsults = useExportExternalConsults();

  const rows = useMemo(
    () => (response?.data ?? []).map(toConsultView),
    [response],
  );
  const paginationMeta = response?.pagination;

  const hasFilters = Object.values(filters).some(
    (value) => value !== undefined,
  );

  const clearFilters = useCallback(() => {
    cursorPagination.goNewest();
    dateTimePicker.clearDateRange();
    updateUrlParams({
      externalName: null,
      sessionId: null,
      outcome: null,
      startDate: null,
      endDate: null,
    });
  }, [cursorPagination.goNewest, dateTimePicker, updateUrlParams]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load guardrail consults"
        onRetry={() => refetch()}
      />
    );
  }

  return (
    <div>
      <CollectionFilters>
        <FilterBar
          leading
          onClearFilters={hasFilters ? clearFilters : undefined}
          search={
            <SearchInput
              paramName="externalName"
              placeholder="External name"
              paginationMode="cursor"
              onSearchChange={cursorPagination.goNewest}
              isLoading={isFetching}
            />
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={exportConsults.isPending}
              onClick={() => exportConsults.mutate(filters)}
            >
              {exportConsults.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              <span>Export JSONL</span>
            </Button>
          }
        >
          <SearchInput
            paramName="sessionId"
            placeholder="Session ID"
            paginationMode="cursor"
            onSearchChange={cursorPagination.goNewest}
            className="w-56"
          />
          <FilterSelect
            value={filters.outcome ?? ALL_VALUE}
            onValueChange={(value) => {
              cursorPagination.goNewest();
              updateUrlParams({ outcome: value === ALL_VALUE ? null : value });
            }}
            placeholder="Filter by outcome"
            items={OUTCOME_OPTIONS}
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

      <DataTable<ConsultView, unknown>
        columns={COLUMNS}
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
        emptyMessage="No guardrail consults recorded yet. Annotator and authority calls will appear here as they happen."
        filteredEmptyMessage="No consults match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => setSelected(row)}
      />

      <ConsultDetailSheet view={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

// === Internal helpers ===

const ALL_VALUE = "all";

const OUTCOME_OPTIONS = [
  { value: ALL_VALUE, label: "All outcomes" },
  ...ALL_OUTCOMES.map((outcome) => ({
    value: outcome,
    label: OUTCOME_LABEL[outcome],
  })),
];

function parseOutcome(
  value: string | null,
): ExternalConsultOutcome | undefined {
  return ALL_OUTCOMES.find((outcome) => outcome === value);
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

const Muted = () => <span className="text-xs text-muted-foreground">—</span>;

const COLUMNS: ColumnDef<ConsultView>[] = [
  {
    id: "createdAt",
    header: "Time",
    size: 180,
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="text-sm">
          {formatRelativeTimeFromNow(row.original.consult.createdAt)}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {formatDate({
            date: row.original.consult.createdAt,
            dateFormat: "MMM d, yyyy · HH:mm:ss",
          })}
        </div>
      </div>
    ),
  },
  {
    id: "externalName",
    header: "External",
    size: 200,
    cell: ({ row }) => (
      <span className="truncate font-mono text-xs">
        {row.original.consult.externalName}
      </span>
    ),
  },
  {
    id: "tool",
    header: "Tool",
    size: 220,
    cell: ({ row }) =>
      row.original.toolCall ? (
        <span className="truncate font-mono text-xs">
          {row.original.toolCall.name}
        </span>
      ) : (
        <Muted />
      ),
  },
  {
    id: "duration",
    header: "Duration",
    size: 100,
    cell: ({ row }) => (
      <span className="text-sm tabular-nums">
        {formatDuration(row.original.consult.durationMs)}
      </span>
    ),
  },
  {
    id: "outcome",
    header: "Outcome",
    size: 140,
    cell: ({ row }) => (
      <ConsultOutcomeBadge outcome={row.original.consult.outcome} />
    ),
  },
];
