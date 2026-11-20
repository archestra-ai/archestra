"use client";

import {
  ArrowLeftRight,
  Download,
  Layers,
  Loader2,
  Megaphone,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import { yellHref } from "@/app/openappa/_parts/yell-row";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import {
  type ExternalConsultOutcome,
  type GuardrailEventFilters,
  useExportExternalConsults,
  useGuardrailEvents,
} from "@/lib/openappa/external-consults.query";
import { useResolveOpenAppaYell } from "@/lib/openappa-yells.query";
import { toConsultView } from "./consult-details";
import { ALL_OUTCOMES, OUTCOME_LABEL } from "./consult-outcome-badge";
import {
  buildGuardrailLogColumns,
  type GuardrailLogRow,
} from "./guardrail-log-columns";

export function ConsultsTable() {
  const { searchParams, updateQueryParams: updateUrlParams } =
    useDataTableQueryParams();
  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  const router = useRouter();

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl: searchParams.get("startDate"),
    endDateFromUrl: searchParams.get("endDate"),
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

  const type = parseType(searchParams.get("type"));
  const filters: GuardrailEventFilters = {
    type: type === ALL_VALUE ? undefined : type,
    search: searchParams.get("search") || undefined,
    // Each narrows the timeline to the kind it describes.
    outcome:
      type === "yell" ? undefined : parseOutcome(searchParams.get("outcome")),
    yellStatus:
      type === "consult"
        ? undefined
        : parseYellStatus(searchParams.get("yellStatus")),
    from: dateTimePicker.startDateParam,
    to: dateTimePicker.endDateParam,
  };
  // The export is of consults, with the filters that apply to them.
  const consultFilters = {
    search: filters.search,
    outcome: filters.outcome,
    from: filters.from,
    to: filters.to,
  };
  const { data: canResolve } = useHasPermissions({ guardrailsYell: ["read"] });
  const resolve = useResolveOpenAppaYell();

  const {
    data: response,
    isFetching,
    isLoadingError,
    refetch,
  } = useGuardrailEvents({
    filters,
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
  });
  const exportConsults = useExportExternalConsults();

  const rows = useMemo(
    () =>
      (response?.data ?? []).map(
        (event): GuardrailLogRow =>
          event.type === "consult"
            ? {
                kind: "consult",
                id: event.consult.id,
                view: toConsultView(event.consult),
              }
            : { kind: "yell", id: event.yell.id, yell: event.yell },
      ),
    [response],
  );
  const { mutate: resolveYell, isPending: resolving } = resolve;
  const columns = useMemo(
    () =>
      buildGuardrailLogColumns({
        maxMs: Math.max(
          1,
          ...rows.map((row) =>
            row.kind === "consult" ? (row.view.consult.durationMs ?? 0) : 0,
          ),
        ),
        canResolve: canResolve === true,
        resolving,
        onResolve: (yell) =>
          resolveYell({ id: yell.id, resolved: !yell.resolvedAt }),
      }),
    [rows, canResolve, resolving, resolveYell],
  );
  const paginationMeta = response?.pagination;

  const hasFilters = Object.values(filters).some(
    (value) => value !== undefined,
  );

  const clearFilters = useCallback(() => {
    dateTimePicker.clearDateRange();
    updateUrlParams({
      type: null,
      search: null,
      outcome: null,
      yellStatus: null,
      startDate: null,
      endDate: null,
    });
  }, [dateTimePicker, updateUrlParams]);

  if (isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load the Guardrails log"
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
              placeholder="Service, session ID or report"
              paginationMode="cursor"
              isLoading={isFetching}
            />
          }
          tuckActionsWhenCompact
          actions={
            <Button
              variant="outline"
              size="sm"
              disabled={exportConsults.isPending || type === "yell"}
              onClick={() => exportConsults.mutate(consultFilters)}
            >
              {exportConsults.isPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Download className="size-4" />
              )}
              <span>Export consults</span>
            </Button>
          }
        >
          <FilterSelect
            value={type}
            onValueChange={(value) => {
              updateUrlParams({
                type: value === ALL_VALUE ? null : value,
                // A filter of the other kind would empty the list.
                ...(value === "yell" ? { outcome: null } : {}),
                ...(value === "consult" ? { yellStatus: null } : {}),
              });
            }}
            ariaLabel="Record type"
            placeholder="Filter by type"
            showSearch={false}
            items={TYPE_OPTIONS}
            inactiveValue={ALL_VALUE}
          />
          {type !== "yell" && (
            <FilterSelect
              value={filters.outcome ?? ALL_VALUE}
              onValueChange={(value) => {
                updateUrlParams({
                  outcome: value === ALL_VALUE ? null : value,
                  yellStatus: null,
                });
              }}
              placeholder="Filter by consult outcome"
              items={OUTCOME_OPTIONS}
              inactiveValue={ALL_VALUE}
            />
          )}
          {type !== "consult" && (
            <FilterSelect
              value={filters.yellStatus ?? ALL_VALUE}
              onValueChange={(value) => {
                updateUrlParams({
                  yellStatus: value === ALL_VALUE ? null : value,
                  outcome: null,
                });
              }}
              ariaLabel="Yell status"
              placeholder="Filter by yell status"
              showSearch={false}
              items={YELL_STATUS_OPTIONS}
              inactiveValue={ALL_VALUE}
            />
          )}
        </FilterBar>
      </CollectionFilters>

      <DataTable<GuardrailLogRow, unknown>
        columns={columns}
        fixedWidthColumnIds={["status", "latency", "time"]}
        flexibleColumnIds={["service", "tool"]}
        data={rows}
        getRowId={(row) => `${row.kind}:${row.id}`}
        hideSelectedCount
        cursorPagination={cursorPagination.tableState(paginationMeta)}
        manualPagination
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyMessage="Nothing recorded yet. Guardrails consults of external services and yells from agents appear here as they happen."
        filteredEmptyMessage="Nothing matches your filters"
        onClearFilters={clearFilters}
        // A consult opens on its own page, which leads on to the session
        // trace it happened in when that session was logged.
        onRowClick={(row, event) => {
          // A yell's shortcuts and actions act on their own.
          if (
            row.kind === "yell" &&
            (event.target as HTMLElement).closest("a, button")
          )
            return;
          router.push(
            row.kind === "consult"
              ? `/consults/logs/${row.id}`
              : yellHref(row.id),
          );
        }}
      />
    </div>
  );
}

// === Internal helpers ===

const ALL_VALUE = "all";

const OUTCOME_OPTIONS = [
  { value: ALL_VALUE, label: "All consult outcomes" },
  ...ALL_OUTCOMES.map((outcome) => ({
    value: outcome,
    label: OUTCOME_LABEL[outcome],
  })),
];

const TYPE_OPTIONS = [
  {
    value: ALL_VALUE,
    label: "Consults and yells",
    hint: "Everything Guardrails recorded",
    icon: Layers,
  },
  {
    value: "consult",
    label: "Consults",
    hint: "Requests to external services",
    icon: ArrowLeftRight,
  },
  {
    value: "yell",
    label: "Yells",
    hint: "Reports agents raised about blocks",
    icon: Megaphone,
  },
].map(({ icon: Icon, hint, ...option }) => ({
  ...option,
  searchText: `${option.label} ${hint}`,
  content: (
    <span className="flex items-center gap-2.5">
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0">
        <span className="block">{option.label}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {hint}
        </span>
      </span>
    </span>
  ),
  // The trigger keeps to one line.
  selectedContent: (
    <span className="flex items-center gap-2">
      <Icon className="size-4 shrink-0" />
      <span>{option.label}</span>
    </span>
  ),
}));

const YELL_STATUS_OPTIONS = [
  { value: ALL_VALUE, label: "All yell statuses" },
  { value: "unresolved", label: "Unresolved yells" },
  { value: "resolved", label: "Resolved yells" },
];

function parseType(value: string | null) {
  return value === "consult" || value === "yell" ? value : ALL_VALUE;
}

function parseYellStatus(value: string | null) {
  return value === "unresolved" || value === "resolved" ? value : undefined;
}

function parseOutcome(
  value: string | null,
): ExternalConsultOutcome | undefined {
  return ALL_OUTCOMES.find((outcome) => outcome === value);
}
