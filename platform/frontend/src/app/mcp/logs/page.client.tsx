"use client";

import {
  type archestraApiTypes,
  extractMcpExecutedAs,
  isLockedChatUnavailableContent,
  parseFullToolName,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Boxes, MessagesSquare, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AgentSelector } from "@/components/agent-selector";
import { ExecutedAsBadge } from "@/components/executed-as-badge";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
} from "@/components/filter-bar";
import { LockedChatContentUnavailableLabel } from "@/components/locked-chat-content-unavailable";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { QueryLoadError } from "@/components/query-load-error";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import { DateTimeRangePicker } from "@/components/ui/date-time-range-picker";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useCursorPagination } from "@/lib/hooks/use-cursor-pagination";
import { useDateTimeRangePicker } from "@/lib/hooks/use-date-time-range-picker";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp/mcp-server.query";
import {
  formatAuthMethod,
  formatCallerIdentity,
  useMcpToolCalls,
} from "@/lib/mcp/mcp-tool-call.query";
import { resolveMcpToolCallStatus } from "@/lib/mcp-logs/tool-call-status";
import { formatDate, formatRelativeTimeFromNow } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

type McpToolCallData =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

export default function McpGatewayLogsPage({
  initialData,
}: {
  initialData?: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
  };
}) {
  return (
    <div>
      <ErrorBoundary>
        <McpToolCallsTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function McpToolCallsTable({
  initialData,
}: {
  initialData?: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params for filters
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const profileIdFromUrl =
    searchParams.get("profileId") || searchParams.get("profileID");
  const mcpServerNameFromUrl = searchParams.get("mcpServerName") ?? "all";
  const searchFromUrl = searchParams.get("search");
  const cursorFromUrl = searchParams.get("cursor");
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const cursorPagination = useCursorPagination({
    defaultPageSize: DEFAULT_TABLE_LIMIT,
  });
  useEffect(() => {
    setProfileFilter(profileIdFromUrl || "all");
    cursorPagination.goNewest();
  }, [cursorPagination.goNewest, profileIdFromUrl]);

  useEffect(() => {
    if (!cursorFromUrl && !pageFromUrl && !pageSizeFromUrl && !searchFromUrl)
      return;
    const params = new URLSearchParams(searchParams.toString());
    params.delete("cursor");
    params.delete("page");
    params.delete("pageSize");
    params.delete("search");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }, [
    cursorFromUrl,
    pageFromUrl,
    pageSizeFromUrl,
    pathname,
    router,
    searchFromUrl,
    searchParams,
  ]);

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
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
      cursorPagination.goNewest();
      updateUrlParams({
        profileId: value === "all" ? null : value,
        profileID: null,
      });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  const handleMcpServerChange = useCallback(
    (value: string) => {
      cursorPagination.goNewest();
      updateUrlParams({ mcpServerName: value === "all" ? null : value });
    },
    [cursorPagination.goNewest, updateUrlParams],
  );

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        cursorPagination.goNewest();
        updateUrlParams({
          startDate,
          endDate,
        });
      },
      [cursorPagination.goNewest, updateUrlParams],
    ),
  });

  const {
    data: mcpToolCallsResponse,
    isFetching,
    isLoadingError: isMcpToolCallsLoadError,
    refetch: refetchMcpToolCalls,
  } = useMcpToolCalls({
    agentId: profileFilter !== "all" ? profileFilter : undefined,
    mcpServerName:
      mcpServerNameFromUrl !== "all" ? mcpServerNameFromUrl : undefined,
    limit: cursorPagination.pageSize,
    cursor: cursorPagination.cursor,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    initialData: initialData?.mcpToolCalls,
  });

  const { data: agents } = useProfiles({
    filters: { agentTypes: ["agent", "mcp_gateway"] },
  });

  const { data: mcpServers } = useMcpServers();
  const { data: canReadMcpRegistry } = useHasPermissions({
    mcpRegistry: ["read"],
  });
  const { data: catalogItems } = useInternalMcpCatalog({
    enabled: canReadMcpRegistry === true,
  });

  // Tool-call rows store the installed server's deployment name. Join it to
  // the catalog metadata already used by the registry so the log can show the
  // human-readable name and its icon without changing the logs API.
  const serverDisplayByName = useMemo(() => {
    const catalogById = new Map(
      catalogItems?.map((item) => [item.id, item]) ?? [],
    );
    const map = new Map<
      string,
      { name: string; icon: string | null; catalogId: string }
    >();
    if (mcpServers) {
      for (const server of mcpServers) {
        const catalog = catalogById.get(server.catalogId);
        map.set(server.name, {
          name: server.catalogName ?? catalog?.name ?? server.name,
          icon: catalog?.icon ?? null,
          catalogId: server.catalogId,
        });
      }
    }
    return map;
  }, [catalogItems, mcpServers]);

  const mcpToolCalls = mcpToolCallsResponse?.data ?? [];
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
        const secondaryLabel =
          displayName !== serverName
            ? serverName
            : installed
              ? undefined
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
          searchText: `${displayName} ${serverName}`,
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
      size: 290,
      minSize: 245,
      cell: ({ row }) => {
        const call = row.original.toolCall;
        const method = row.original.method || "tools/call";
        const fullName = isLockedChatUnavailableContent(call)
          ? undefined
          : call?.name;
        const toolName = fullName
          ? parseFullToolName(fullName).toolName || fullName
          : null;
        const rawServerName = row.original.mcpServerName;
        const serverDisplay = serverDisplayByName.get(rawServerName);
        const serverName = serverDisplay?.name ?? rawServerName;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <McpCatalogIcon
                icon={serverDisplay?.icon}
                catalogId={serverDisplay?.catalogId}
                size={14}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {isLockedChatUnavailableContent(call) ? (
                  <LockedChatContentUnavailableLabel value={call} />
                ) : toolName ? (
                  <code className="font-mono text-xs">{toolName}</code>
                ) : (
                  formatMcpMethod(method)
                )}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                <span className="truncate" title={rawServerName}>
                  {serverName || "Platform"}
                </span>
                {method === "tools/call" ? null : (
                  <Badge
                    variant="outline"
                    className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
                  >
                    {method}
                  </Badge>
                )}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "agent",
      accessorFn: (row) => getGatewayDisplayName(row, agents),
      header: "Gateway",
      size: 205,
      minSize: 160,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Boxes className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {getGatewayDisplayName(row.original, agents)}
            </div>
            <div className="text-xs text-muted-foreground">
              {row.original.ownerType === "app" ? "App" : "MCP gateway"}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "identity",
      header: "Identity",
      size: 245,
      minSize: 215,
      cell: ({ row }) => {
        const { userName, authMethod } = row.original;
        const executedAs = extractMcpExecutedAs(row.original.toolResult);
        if (!userName && !authMethod && !executedAs) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <User className="size-3.5" />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">
                {userName ?? "Unattributed"}
              </div>
              <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {authMethod ? (
                  <span className="shrink-0">
                    {formatAuthMethod(authMethod)}
                  </span>
                ) : null}
                {authMethod && executedAs ? (
                  <span aria-hidden="true">·</span>
                ) : null}
                {executedAs ? (
                  <span className="min-w-0 overflow-hidden">
                    <ExecutedAsBadge
                      executedAs={executedAs}
                      caller={formatCallerIdentity(row.original)}
                    />
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Result",
      size: 105,
      minSize: 95,
      cell: ({ row }) => {
        const result = row.original.toolResult;
        const method = row.original.method || "tools/call";

        // The status lives inside the result, so a locked-chat row has none to
        // report. Falling through to the "Success" badge below would assert an
        // outcome the row does not record.
        if (isLockedChatUnavailableContent(result)) {
          return <LockedChatContentUnavailableLabel value={result} />;
        }

        // For tools/call, resolve success / error / cancelled (a call the
        // user stopped mid-flight — neither a success nor a failure).
        if (
          method === "tools/call" &&
          result &&
          typeof result === "object" &&
          "isError" in result
        ) {
          const status = resolveMcpToolCallStatus(result);
          return (
            <Badge
              variant={
                status === "error"
                  ? "destructive"
                  : status === "cancelled"
                    ? "secondary"
                    : "default"
              }
              className="text-xs whitespace-nowrap"
            >
              {status === "error"
                ? "Error"
                : status === "cancelled"
                  ? "Cancelled"
                  : "Success"}
            </Badge>
          );
        }

        // For other methods, just show success
        return (
          <Badge variant="default" className="text-xs whitespace-nowrap">
            Success
          </Badge>
        );
      },
    },
    {
      id: "createdAt",
      header: "Time",
      size: 175,
      minSize: 160,
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="text-sm">
            {formatRelativeTimeFromNow(row.original.createdAt)}
          </div>
          <div className="truncate font-mono text-[11px] text-muted-foreground">
            {formatDate({
              date: row.original.createdAt,
              dateFormat: "MMM d, yyyy · HH:mm:ss",
            })}
          </div>
        </div>
      ),
    },
  ];

  const hasFilters =
    profileFilter !== "all" ||
    mcpServerNameFromUrl !== "all" ||
    dateTimePicker.startDate !== undefined ||
    dateTimePicker.endDate !== undefined;

  const clearFilters = useCallback(() => {
    setProfileFilter("all");
    cursorPagination.goNewest();
    dateTimePicker.clearDateRange();
    updateUrlParams({
      profileId: null,
      profileID: null,
      mcpServerName: null,
      startDate: null,
      endDate: null,
      search: null,
      cursor: null,
      page: null,
      pageSize: null,
    });
  }, [cursorPagination.goNewest, dateTimePicker, updateUrlParams]);

  // Shared date picker component
  const datePickerComponent = (
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
  );

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
            agents={agents ?? []}
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
            pinnedItems={[{ value: "all", label: "All MCP Servers" }]}
            className={filterControlClass({
              active: mcpServerNameFromUrl !== "all",
            })}
            contentClassName="min-w-[min(20rem,calc(100vw-2rem))]"
          />
          {datePickerComponent}
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        data={mcpToolCalls}
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
        emptyIcon={MessagesSquare}
        emptyMessage="No MCP tool calls found. Tool calls will appear here when agents use MCP tools."
        filteredEmptyMessage="No MCP logs match your filters"
        onClearFilters={clearFilters}
        onRowClick={(row) => {
          router.push(`/mcp/logs/${row.id}`);
        }}
      />
    </div>
  );
}

function getGatewayDisplayName(
  row: Pick<McpToolCallData, "ownerType" | "agentId" | "appName">,
  agents: archestraApiTypes.GetAllAgentsResponses["200"] | undefined,
) {
  // App-owned calls have no agent by design — attribute them to the app
  // instead of falling through to the deleted-gateway label.
  if (row.ownerType === "app") {
    return row.appName ?? "Deleted App";
  }
  const agent = agents?.find((a) => a.id === row.agentId);
  return (
    agent?.name ?? (row.agentId === null ? "Deleted MCP Gateway" : "Unknown")
  );
}

function formatMcpMethod(method: string) {
  if (method === "initialize") return "Initialize";
  if (method === "tools/list") return "List tools";
  if (method === "tools/call") return "Tool call";
  return method;
}
