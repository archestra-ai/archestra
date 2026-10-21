"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { MessagesSquare } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLogsHeaderAction } from "@/app/_parts/logs-section-layout";
import { AgentSelector } from "@/components/agent-selector";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
} from "@/components/filter-bar";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { TimeRangePicker } from "@/components/time-range-picker/time-range-picker";
import { DataTable } from "@/components/ui/data-table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { UserFilterSelect } from "@/components/user-client-filter-selects";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useAgentOptionsByIds } from "@/lib/agent-options.query";
import { resourceOwnerLabel } from "@/lib/agent-owner-label";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { llmSessionHref } from "@/lib/interactions/llm-log-links";
import { useMcpToolCalls } from "@/lib/mcp/mcp-tool-call.query";
import { useMcpServerDisplayByName } from "@/lib/mcp-logs/use-mcp-server-display";
import { ErrorBoundary } from "../../_parts/error-boundary";
import { CallCell, StatusCell } from "./_parts/call-cell";
import { CredentialCell } from "./_parts/credential-cell";
import { GatewayCell } from "./_parts/gateway-cell";
import { CalledAtCell, DurationCell } from "./_parts/timing-cells";
import type { McpToolCallRow } from "./_parts/types";

type McpToolCallData = McpToolCallRow;

export default function McpGatewayLogsPage() {
  return (
    <div>
      <ErrorBoundary>
        <McpToolCallsTable />
      </ErrorBoundary>
    </div>
  );
}

function McpToolCallsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params for filters
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const profileIdFromUrl =
    searchParams.get("profileId") || searchParams.get("profileID");
  const mcpServerNameFromUrl = searchParams.get("mcpServerName") ?? "all";
  const userIdFromUrl = searchParams.get("userId") ?? "all";
  const searchFromUrl = searchParams.get("search");

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  useEffect(() => {
    setProfileFilter(profileIdFromUrl || "all");
  }, [profileIdFromUrl]);

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

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      // A cursor belongs to the listing it was issued for.
      if (!("cursor" in updates)) {
        params.delete("cursor");
        params.delete("page");
      }
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === "") {
          params.delete(key);
        } else {
          params.set(key, value);
        }
      });
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Profile filter change handler
  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
      updateUrlParams({
        profileId: value === "all" ? null : value,
        profileID: null,
      });
    },
    [updateUrlParams],
  );

  const handleMcpServerChange = useCallback(
    (value: string) => {
      updateUrlParams({ mcpServerName: value === "all" ? null : value });
    },
    [updateUrlParams],
  );

  const handleUserFilterChange = useCallback(
    (value: string) => {
      updateUrlParams({ userId: value === "all" ? null : value });
    },
    [updateUrlParams],
  );

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        updateUrlParams({
          startDate,
          endDate,
        });
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

  const {
    data: mcpToolCallsResponse,
    isFetching,
    isLoadingError: isMcpToolCallsLoadError,
    refetch: refetchMcpToolCalls,
  } = useMcpToolCalls({
    agentId: profileFilter !== "all" ? profileFilter : undefined,
    mcpServerName:
      mcpServerNameFromUrl !== "all" ? mcpServerNameFromUrl : undefined,
    userId: userIdFromUrl !== "all" ? userIdFromUrl : undefined,
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
  });

  // The install list (owners, teams) only labels the server filter's
  // options, so it loads once the filter opens, or when a server is already
  // selected in the URL and the trigger needs its label. The latch stays set
  // on purpose: closing the filter is no reason to drop a list it will show
  // again.
  const [serverFilterOpened, setServerFilterOpened] = useState(false);
  const { servers: mcpServers, displayByName: serverDisplayByName } =
    useMcpServerDisplayByName({
      installations: serverFilterOpened || mcpServerNameFromUrl !== "all",
    });
  // Without log:admin the server scopes every listing to the caller's own
  // rows, so a user picker would have nothing to choose between.
  const { data: canSeeAllLogs } = useHasPermissions({ log: ["admin"] });

  const mcpToolCalls = mcpToolCallsResponse?.data ?? [];
  const { data: agents } = useAgentOptionsByIds({
    ids: mcpToolCalls.flatMap((call) => (call.agentId ? [call.agentId] : [])),
  });
  const paginationMeta = mcpToolCallsResponse?.pagination;

  const mcpServerOptions = useMemo(() => {
    const installedByName = new Map(
      (mcpServers ?? []).map((server) => [server.name, server]),
    );
    const serverNames = new Set(installedByName.keys());
    for (const call of mcpToolCallsResponse?.data ?? []) {
      serverNames.add(call.mcpServerName);
    }

    return [...serverNames]
      .map((serverName) => {
        const installed = installedByName.get(serverName);
        const display = serverDisplayByName.get(serverName);
        const displayName = display?.name ?? serverName;
        const secondaryLabel = installed
          ? resourceOwnerLabel(
              {
                scope: installed.scope,
                ownerEmail: installed.ownerEmail,
                teamName: installed.teamDetails?.name,
              },
              {
                personalFallback: "Owner unavailable",
                teamFallback: "Team installation",
                organization: "Organization installation",
              },
            )
          : "From logs";
        const icon = (
          <span
            key={serverName}
            className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
          >
            <McpCatalogIcon
              icon={display?.icon}
              catalogId={display?.catalogId ?? installed?.catalogId}
              size={14}
            />
          </span>
        );
        return {
          value: serverName,
          label: displayName,
          searchText: `${displayName} ${secondaryLabel} ${serverName}`,
          content: (
            <span className="flex min-w-0 items-center gap-2">
              {icon}
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {displayName}
                </span>
                {secondaryLabel ? (
                  <span className="block truncate text-xs text-muted-foreground">
                    {secondaryLabel}
                  </span>
                ) : null}
              </span>
            </span>
          ),
          selectedContent: (
            <span className="flex min-w-0 items-center gap-2">
              {icon}
              <span className="truncate">{displayName}</span>
            </span>
          ),
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [mcpServers, mcpToolCallsResponse?.data, serverDisplayByName]);

  const columns: ColumnDef<McpToolCallData>[] = [
    {
      id: "call",
      header: "Call",
      size: 360,
      minSize: 280,
      cell: ({ row }) => (
        <CallCell
          row={row.original}
          server={serverDisplayByName.get(row.original.mcpServerName)}
        />
      ),
    },
    {
      id: "agent",
      header: "Gateway",
      size: 228,
      minSize: 200,
      cell: ({ row }) => (
        <GatewayCell
          row={row.original}
          gateway={agents?.find((a) => a.id === row.original.agentId)}
        />
      ),
    },
    {
      id: "credential",
      header: "Credential",
      size: 220,
      minSize: 190,
      cell: ({ row }) => <CredentialCell row={row.original} />,
    },
    {
      id: "status",
      header: "Status",
      size: 112,
      minSize: 104,
      cell: ({ row }) => <StatusCell row={row.original} />,
    },
    {
      id: "duration",
      header: () => <div className="text-right">Duration</div>,
      size: 92,
      minSize: 84,
      cell: ({ row }) => <DurationCell row={row.original} />,
    },
    {
      id: "createdAt",
      header: () => <div className="text-right">Time</div>,
      size: 128,
      minSize: 120,
      cell: ({ row }) => <CalledAtCell row={row.original} />,
    },
  ];

  const hasFilters =
    profileFilter !== "all" ||
    mcpServerNameFromUrl !== "all" ||
    userIdFromUrl !== "all" ||
    dateTimePicker.startDate !== undefined ||
    dateTimePicker.endDate !== undefined;

  const clearFilters = useCallback(() => {
    setProfileFilter("all");
    dateTimePicker.clearDateRange();
    updateUrlParams({
      profileId: null,
      profileID: null,
      mcpServerName: null,
      userId: null,
      startDate: null,
      endDate: null,
      search: null,
      cursor: null,
      page: null,
    });
  }, [dateTimePicker, updateUrlParams]);

  if (isMcpToolCallsLoadError) {
    return (
      <div className="space-y-4">
        <QueryLoadError
          title="Couldn't load logs"
          onRetry={() => refetchMcpToolCalls()}
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
          {/* Two people's personal gateways can both be called "My Gateway", so
            the picker carries each one's scope and owner email rather than a
            bare name. */}
          <AgentSelector
            mode="single"
            flat
            compactTrigger
            remote={{ filters: { agentTypes: ["agent", "mcp_gateway"] } }}
            value={profileFilter}
            onValueChange={handleProfileFilterChange}
            sentinelOption={{
              value: "all",
              label: "All Agents & MCP Gateways",
            }}
            // Only reached when the URL pins an id that no longer resolves to an
            // agent (e.g. a bookmarked filter whose target was deleted); the
            // sentinel label covers the ordinary unfiltered state.
            placeholder="Filter by Agent"
            searchPlaceholder="Search agents and MCP gateways…"
            emptyMessage="No agents or MCP gateways found."
            className={filterControlClass({ active: profileFilter !== "all" })}
          />
          <SearchableSelect
            value={mcpServerNameFromUrl}
            onValueChange={handleMcpServerChange}
            ariaLabel="Filter by MCP server"
            searchPlaceholder="Search MCP servers…"
            emptyMessage="No MCP servers found."
            items={mcpServerOptions}
            onOpenChange={(open) => {
              if (open) setServerFilterOpened(true);
            }}
            pinnedItems={[{ value: "all", label: "All MCP Servers" }]}
            className={filterControlClass({
              active: mcpServerNameFromUrl !== "all",
            })}
            contentClassName="min-w-[min(20rem,calc(100vw-2rem))]"
          />
          {canSeeAllLogs ? (
            <UserFilterSelect
              value={userIdFromUrl}
              onValueChange={handleUserFilterChange}
              source="members"
            />
          ) : null}
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        fixedWidthColumnIds={[
          "agent",
          "credential",
          "status",
          "duration",
          "createdAt",
        ]}
        flexibleColumnIds={["call"]}
        data={mcpToolCalls}
        hideSelectedCount
        cursorPagination={cursorPagination.tableState(paginationMeta)}
        manualPagination
        isLoading={isFetching}
        hasActiveFilters={hasFilters}
        emptyIcon={MessagesSquare}
        emptyMessage="No MCP tool calls found. Tool calls will appear here when agents use MCP tools."
        filteredEmptyMessage="No MCP logs match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => router.push(mcpToolCallHref(row))}
      />
    </div>
  );
}

/**
 * Where a row opens: the call in its LLM session's trace when the call is
 * linked to one, otherwise its own detail page.
 */
function mcpToolCallHref(row: Pick<McpToolCallData, "id" | "sessionId">) {
  return row.sessionId
    ? llmSessionHref(row.sessionId, { toolCall: row.id })
    : `/mcp/logs/${row.id}`;
}
