"use client";

import type { archestraApiTypes } from "@shared";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { TableFilters } from "@/components/table-filters";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useInteractions } from "@/lib/interactions/interaction.query";
import { useMcpToolCalls } from "@/lib/mcp/mcp-tool-call.query";
import { ErrorBoundary } from "../_parts/error-boundary";
import { AUDIT_LOG_SOURCE_LIMIT } from "./_parts/audit-log.types";
import {
  buildAuditLogEvents,
  filterAuditLogEvents,
  getAuditLogSummary,
  getValidTypeFilter,
} from "./_parts/audit-log.utils";
import { auditLogColumns } from "./_parts/audit-log-columns";
import { AuditLogSummaryCards } from "./_parts/audit-log-summary-cards";

type AuditLogInitialData = {
  interactions: archestraApiTypes.GetInteractionsResponses["200"];
  mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
};

export default function AuditLogPage({
  initialData,
}: {
  initialData?: AuditLogInitialData;
}) {
  return (
    <div>
      <ErrorBoundary>
        <AuditLogTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function AuditLogTable({ initialData }: { initialData?: AuditLogInitialData }) {
  const router = useRouter();
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const typeFilter = getValidTypeFilter(searchParams.get("type"));
  const searchQuery = searchParams.get("search") ?? "";
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");

  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        updateQueryParams({ startDate, endDate });
      },
      [updateQueryParams],
    ),
  });

  const { data: interactionsResponse, isFetching: isFetchingInteractions } =
    useInteractions({
      limit: AUDIT_LOG_SOURCE_LIMIT,
      offset: 0,
      sortBy: "createdAt",
      sortDirection: "desc",
      startDate: dateTimePicker.startDateParam,
      endDate: dateTimePicker.endDateParam,
      initialData: initialData?.interactions,
      enabled: typeFilter === "all" || typeFilter === "LLM",
    });

  const { data: mcpToolCallsResponse, isFetching: isFetchingMcpToolCalls } =
    useMcpToolCalls({
      limit: AUDIT_LOG_SOURCE_LIMIT,
      offset: 0,
      sortBy: "createdAt",
      sortDirection: "desc",
      startDate: dateTimePicker.startDateParam,
      endDate: dateTimePicker.endDateParam,
      initialData: initialData?.mcpToolCalls,
      enabled: typeFilter === "all" || typeFilter === "MCP",
    });

  const interactions =
    interactionsResponse?.data ?? initialData?.interactions.data ?? [];
  const mcpToolCalls =
    mcpToolCallsResponse?.data ?? initialData?.mcpToolCalls.data ?? [];

  const auditEvents = useMemo(() => {
    return buildAuditLogEvents({
      interactions,
      mcpToolCalls,
      typeFilter,
    });
  }, [interactions, mcpToolCalls, typeFilter]);

  const filteredEvents = useMemo(() => {
    return filterAuditLogEvents({ events: auditEvents, searchQuery });
  }, [auditEvents, searchQuery]);

  const { totalCount, allowedCount, blockedOrFailedCount } = useMemo(
    () => getAuditLogSummary(filteredEvents),
    [filteredEvents],
  );
  const hasActiveFilters =
    searchQuery.length > 0 ||
    typeFilter !== "all" ||
    dateTimePicker.startDate !== undefined;

  const clearFilters = useCallback(() => {
    dateTimePicker.clearDateRange();
    updateQueryParams({
      search: null,
      type: null,
      startDate: null,
      endDate: null,
    });
  }, [dateTimePicker, updateQueryParams]);

  return (
    <PageLayout
      title="Audit Log"
      description="Review security-relevant platform activity across LLM and MCP events."
      tabs={[
        { label: "Audit", href: "/audit-log" },
        { label: "LLM", href: "/llm/logs" },
        { label: "MCP", href: "/mcp/logs" },
      ]}
    >
      <TableFilters>
        <SearchInput
          placeholder="Search audit events..."
          value={searchQuery}
          onSearchChange={(value) =>
            updateQueryParams({ search: value || null })
          }
          syncQueryParams={false}
        />
        <Select
          value={typeFilter}
          onValueChange={(value) => updateQueryParams({ type: value })}
        >
          <SelectTrigger className="w-[160px]">
            <SelectValue placeholder="Event type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="LLM">LLM</SelectItem>
            <SelectItem value="MCP">MCP</SelectItem>
          </SelectContent>
        </Select>
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
      <AuditLogSummaryCards
        totalCount={totalCount}
        allowedCount={allowedCount}
        blockedOrFailedCount={blockedOrFailedCount}
      />
      <DataTable
        columns={auditLogColumns}
        data={filteredEvents}
        emptyMessage="No audit events found. LLM requests and MCP tool calls will appear here when activity is recorded."
        hasActiveFilters={hasActiveFilters}
        filteredEmptyMessage="No audit events match your filters."
        hidePaginationWhenSinglePage
        isLoading={isFetchingInteractions || isFetchingMcpToolCalls}
        onClearFilters={clearFilters}
        onRowClick={(row) => {
          router.push(row.href);
        }}
      />
    </PageLayout>
  );
}
