"use client";

import { Download, Loader2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
} from "@/components/filter-bar";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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
import { buildConsultColumns } from "./consult-columns";
import { ConsultDetailSheet } from "./consult-detail-sheet";
import { type ConsultView, toConsultView } from "./consult-details";
import { ALL_OUTCOMES, OUTCOME_LABEL } from "./consult-outcome-badge";

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

  const filters: ExternalConsultFilters = {
    search: searchParams.get("search") || undefined,
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
  const columns = useMemo(
    () =>
      buildConsultColumns(
        Math.max(1, ...rows.map((row) => row.consult.durationMs ?? 0)),
      ),
    [rows],
  );
  const paginationMeta = response?.pagination;

  const hasFilters = Object.values(filters).some(
    (value) => value !== undefined,
  );

  const clearFilters = useCallback(() => {
    cursorPagination.goNewest();
    dateTimePicker.clearDateRange();
    updateUrlParams({
      search: null,
      outcome: null,
      startDate: null,
      endDate: null,
    });
  }, [cursorPagination.goNewest, dateTimePicker, updateUrlParams]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load Guardrails consults"
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
              paramName="search"
              placeholder="Service or session ID"
              paginationMode="cursor"
              onSearchChange={cursorPagination.goNewest}
              isLoading={isFetching}
            />
          }
          tuckActionsWhenCompact
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
        </FilterBar>
      </CollectionFilters>

      <DataTable<ConsultView, unknown>
        columns={columns}
        fixedWidthColumnIds={["signal", "latency", "time"]}
        flexibleColumnIds={["service", "tool"]}
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
        emptyMessage="No Guardrails consults recorded yet. Annotator and authority calls will appear here as they happen."
        filteredEmptyMessage="No consults match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => setSelected(row)}
        getRowClassName={(row) =>
          row.consult.id === selected?.consult.id ? "bg-muted" : undefined
        }
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
