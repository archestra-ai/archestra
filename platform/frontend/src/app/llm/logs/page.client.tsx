"use client";

import {
  type ClientFilter,
  INTERACTION_SOURCE_DISPLAY,
  type InteractionSource,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { MessagesSquare } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useMemo } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import { AgentSelector } from "@/components/agent-selector";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { SourceFilterOption } from "@/components/log-filter-option";
import { QueryLoadError } from "@/components/query-load-error";
import { SearchInput } from "@/components/search-input";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { DataTable } from "@/components/ui/data-table";
import {
  ClientFilterSelect,
  UserFilterSelect,
} from "@/components/user-client-filter-selects";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  isSessionId,
  useInteractionSessions,
} from "@/lib/interactions/interaction.query";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import { ErrorBoundary } from "../../_parts/error-boundary";
import { AgentCell } from "./_parts/agent-cell";
import type { LogSession } from "./_parts/logs-table-format";
import { ModelCell } from "./_parts/model-cell";
import { SessionCell } from "./_parts/session-cell";
import { TimeCell } from "./_parts/time-cell";
import { UsageCell } from "./_parts/usage-cell";

export default function LlmProxyLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <SessionsTable />
      </ErrorBoundary>
    </div>
  );
}

function SessionsTable() {
  const router = useRouter();
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const cursorPagination = useCursorPagination();

  // Get URL params
  const profileIdFromUrl = searchParams.get("profileId");
  const userIdFromUrl = searchParams.get("userId");
  const sourceFromUrl = searchParams.get("source");
  const clientFromUrl = searchParams.get("client");
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const searchFromUrl = searchParams.get("search");
  const profileFilter = profileIdFromUrl || "all";
  const userFilter = userIdFromUrl || "all";
  const sourceFilter = sourceFromUrl || "all";
  const clientFilter = clientFromUrl || "all";

  // The logs search box only filters by session ID (free-text content search
  // was removed). Translate the typed term into a sessionId filter when it is a
  // valid session ID; otherwise it filters nothing and we surface a hint.
  const sessionIdFromSearch =
    searchFromUrl && isSessionId(searchFromUrl) ? searchFromUrl : undefined;
  const searchIsNotSessionId = !!searchFromUrl && !sessionIdFromSearch;

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        updateQueryParams({
          startDate,
          endDate,
          page: null,
        });
      },
      [updateQueryParams],
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

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        profileId: value === "all" ? null : value,
        page: null,
      });
    },
    [updateQueryParams],
  );

  const handleUserFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        userId: value === "all" ? null : value,
        page: null,
      });
    },
    [updateQueryParams],
  );

  const handleSourceFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        source: value === "all" ? null : value,
        page: null,
      });
    },
    [updateQueryParams],
  );

  const handleClientFilterChange = useCallback(
    (value: string) => {
      updateQueryParams({
        client: value === "all" ? null : value,
        page: null,
      });
    },
    [updateQueryParams],
  );

  const {
    data: sessionsResponse,
    isFetching,
    isLoadingError,
    refetch: refetchSessions,
  } = useInteractionSessions({
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
    userId: userFilter !== "all" ? userFilter : undefined,
    source:
      sourceFilter !== "all" ? (sourceFilter as InteractionSource) : undefined,
    client: clientFilter !== "all" ? (clientFilter as ClientFilter) : undefined,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    sessionId: sessionIdFromSearch,
    toastOnError: false,
  });

  const { data: canSeeAllLogs } = useHasPermissions({ log: ["admin"] });
  // Read once here: the catalog re-reads the organization on every mount.
  const { label: providerLabel } = useModelProviderCatalog();

  const sessions = sessionsResponse?.data ?? [];
  const { data: agents } = useAgentOptionsByIds({
    ids: sessions.flatMap((session) =>
      session.profileId ? [session.profileId] : [],
    ),
  });
  const paginationMeta = sessionsResponse?.pagination;
  const hasFilters =
    profileFilter !== "all" ||
    userFilter !== "all" ||
    sourceFilter !== "all" ||
    clientFilter !== "all" ||
    dateTimePicker.startDate !== undefined ||
    !!searchFromUrl;

  const clearFilters = useCallback(() => {
    dateTimePicker.clearDateRange();
    updateQueryParams({
      profileId: null,
      userId: null,
      source: null,
      client: null,
      startDate: null,
      endDate: null,
      search: null,
      page: null,
    });
  }, [dateTimePicker, updateQueryParams]);

  const columns: ColumnDef<LogSession>[] = useMemo(
    () => [
      {
        id: "session",
        header: "Session",
        size: 340,
        minSize: 280,
        cell: ({ row }) => <SessionCell session={row.original} />,
      },
      {
        id: "agent",
        header: "Agent",
        size: 228,
        minSize: 200,
        cell: ({ row }) => (
          <AgentCell
            session={row.original}
            agent={agents?.find((a) => a.id === row.original.profileId)}
          />
        ),
      },
      {
        id: "models",
        header: "Model",
        size: 184,
        minSize: 164,
        cell: ({ row }) => (
          <ModelCell session={row.original} providerLabel={providerLabel} />
        ),
      },
      {
        id: "usage",
        header: () => <div className="text-right">Usage</div>,
        size: 124,
        minSize: 116,
        cell: ({ row }) => <UsageCell session={row.original} />,
      },
      {
        id: "time",
        header: () => <div className="text-right">Last request</div>,
        size: 128,
        minSize: 120,
        cell: ({ row }) => <TimeCell session={row.original} />,
      },
    ],
    [agents, providerLabel],
  );

  // A failed fetch leaves no rows; show a retry state instead of the table's
  // "No LLM proxy logs found" empty message, which would misrepresent the error.
  if (isLoadingError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load logs"
          onRetry={() => refetchSessions()}
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
          search={
            <div className={filterSearchClass}>
              <SearchInput
                isLoading={isFetching}
                objectNamePlural="logs"
                searchFields={["session ID"]}
                paramName="search"
                className="relative w-full"
                paginationMode="cursor"
              />
              {/* Keep validation below search without moving the table. */}
              {searchIsNotSessionId && (
                <output className="absolute left-0 top-full z-20 mt-1 w-full rounded-md border bg-popover px-2 py-1 text-xs text-muted-foreground shadow-md">
                  Enter a valid session ID
                </output>
              )}
            </div>
          }
        >
          {/* Two people's personal agents can both be called "My Agent", so the
            picker carries each one's scope and owner email rather than a bare
            name. */}
          <AgentSelector
            mode="single"
            flat
            compactTrigger
            remote={{ filters: { agentTypes: ["agent"] } }}
            value={profileFilter}
            onValueChange={handleProfileFilterChange}
            sentinelOption={{
              value: "all",
              label: "All Agents",
            }}
            // Only reached when the URL pins an id that no longer resolves to an
            // agent (e.g. a bookmarked filter whose target was deleted); the
            // sentinel label covers the ordinary unfiltered state.
            placeholder="Filter by Agent"
            searchPlaceholder="Search agents…"
            emptyMessage="No agents found."
            className={filterControlClass({ active: profileFilter !== "all" })}
          />

          {canSeeAllLogs ? (
            // Without log:admin the server scopes every listing to the caller's
            // own rows, so a user filter would be a one-entry dropdown.
            <UserFilterSelect
              value={userFilter}
              onValueChange={handleUserFilterChange}
              source="logs"
            />
          ) : null}

          <FilterSelect
            value={sourceFilter}
            onValueChange={handleSourceFilterChange}
            placeholder="Filter by Source"
            items={[
              { value: "all", label: "All Sources" },
              ...Object.entries(INTERACTION_SOURCE_DISPLAY).map(
                ([value, { label }]) => ({
                  value,
                  label,
                  content: (
                    <SourceFilterOption source={value as InteractionSource} />
                  ),
                  selectedContent: (
                    <SourceFilterOption source={value as InteractionSource} />
                  ),
                }),
              ),
            ]}
          />

          <ClientFilterSelect
            value={clientFilter}
            onValueChange={handleClientFilterChange}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        flexibleColumnIds={["session"]}
        data={sessions}
        hideSelectedCount
        manualPagination
        cursorPagination={cursorPagination.tableState(paginationMeta)}
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyIcon={MessagesSquare}
        emptyMessage="No LLM proxy logs found. Logs will appear here when agents start making requests."
        filteredEmptyMessage="No LLM logs match your filters"
        onClearFilters={clearFilters}
        onRowClick={(session) => {
          // A request logged without a session is keyed by its own id.
          const sessionKey = session.sessionId ?? session.interactionId;
          if (sessionKey) router.push(llmSessionHref(sessionKey));
        }}
      />
    </div>
  );
}
