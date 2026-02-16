"use client";

import { type archestraApiTypes, parseFullToolName } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, User } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
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
import { useProfiles } from "@/lib/agent.query";
import { useMcpServers } from "@/lib/mcp-server.query";
import { formatAuthMethod, useMcpToolCalls } from "@/lib/mcp-tool-call.query";
import { useDateTimeRangePicker } from "@/lib/use-date-time-range-picker";
import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

type McpToolCallData =
  archestraApiTypes.GetMcpToolCallsResponses["200"]["data"][number];

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") {
    return upArrow;
  }
  if (isSorted === "desc") {
    return downArrow;
  }
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

export default function McpGatewayLogsPage({
  initialData,
}: {
  initialData?: {
    mcpToolCalls: archestraApiTypes.GetMcpToolCallsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
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
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params for filters
  const startDateFromUrl = searchParams.get("startDate");
  const endDateFromUrl = searchParams.get("endDate");
  const profileIdFromUrl = searchParams.get("profileId");
  const searchFromUrl = searchParams.get("search");

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const [searchFilter, setSearchFilter] = useState(searchFromUrl || "");
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
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
      setPagination((prev) => ({ ...prev, pageIndex: 0 })); // Reset to first page
      updateUrlParams({
        profileId: value === "all" ? null : value,
      });
    },
    [updateUrlParams],
  );

  // Search filter change handler
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchFilter(value);
      setPagination((prev) => ({ ...prev, pageIndex: 0 })); // Reset to first page
      updateUrlParams({
        search: value || null,
      });
    },
    [updateUrlParams],
  );

  // Date time range picker hook
  const dateTimePicker = useDateTimeRangePicker({
    startDateFromUrl,
    endDateFromUrl,
    onDateRangeChange: useCallback(
      ({ startDate, endDate }) => {
        setPagination((prev) => ({ ...prev, pageIndex: 0 })); // Reset to first page
        updateUrlParams({
          startDate,
          endDate,
        });
      },
      [updateUrlParams],
    ),
  });

  // Convert TanStack sorting to API format
  const sortBy = sorting[0]?.id;
  const sortDirection = sorting[0]?.desc ? "desc" : "asc";
  // Map UI column ids to API sort fields
  const apiSortBy: NonNullable<
    archestraApiTypes.GetMcpToolCallsData["query"]
  >["sortBy"] =
    sortBy === "method"
      ? "method"
      : sortBy === "createdAt"
        ? "createdAt"
        : undefined;

  const { data: mcpToolCallsResponse } = useMcpToolCalls({
    agentId: profileFilter !== "all" ? profileFilter : undefined,
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortBy: apiSortBy,
    sortDirection,
    startDate: dateTimePicker.startDateParam,
    endDate: dateTimePicker.endDateParam,
    search: searchFilter || undefined,
    initialData: initialData?.mcpToolCalls,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  const { data: mcpServers } = useMcpServers();

  // Map deployment names (e.g. "outlook-2w7avkls6j") to human-readable catalog names (e.g. "Outlook")
  const serverNameToCatalogName = useMemo(() => {
    const map = new Map<string, string>();
    if (mcpServers) {
      for (const server of mcpServers) {
        if (server.catalogName) {
          map.set(server.name, server.catalogName);
        }
      }
    }
    return map;
  }, [mcpServers]);

  const mcpToolCalls = mcpToolCallsResponse?.data ?? [];
  const paginationMeta = mcpToolCallsResponse?.pagination;

  const columns: ColumnDef<McpToolCallData>[] = [
    {
      id: "createdAt",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Date
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({
            date: row.original.createdAt,
          })}
        </div>
      ),
    },
    {
      id: "method",
      header: "Method",
      cell: ({ row }) => {
        const method = row.original.method || "tools/call";
        const variant =
          method === "initialize"
            ? "outline"
            : method === "tools/list"
              ? "secondary"
              : "default";
        return (
          <Badge variant={variant} className="text-xs whitespace-nowrap">
            {method}
          </Badge>
        );
      },
    },
    {
      id: "agent",
      accessorFn: (row) => {
        const agent = agents?.find((a) => a.id === row.agentId);
        return agent?.name ?? "Unknown";
      },
      header: "MCP Gateway",
      cell: ({ row }) => {
        const agent = agents?.find((a) => a.id === row.original.agentId);
        return (
          <TruncatedText message={agent?.name ?? "Unknown"} maxLength={30} />
        );
      },
    },
    {
      id: "user",
      header: "User",
      cell: ({ row }) => {
        const { userName, authMethod } = row.original;
        if (!userName && !authMethod) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        return (
          <div className="flex flex-wrap gap-1">
            {userName && (
              <Badge variant="outline" className="text-xs max-w-[150px]">
                <User className="h-3 w-3 mr-1 shrink-0" />
                <span className="truncate">{userName}</span>
              </Badge>
            )}
            {authMethod && (
              <Badge variant="secondary" className="text-xs whitespace-nowrap">
                {formatAuthMethod(authMethod)}
              </Badge>
            )}
          </div>
        );
      },
    },
    {
      id: "mcpServerName",
      header: "MCP Server",
      cell: ({ row }) => {
        const rawName = row.original.mcpServerName;
        if (!rawName) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        const displayName = serverNameToCatalogName.get(rawName) ?? rawName;
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="max-w-[160px]">
                <Badge
                  variant="secondary"
                  className="text-xs max-w-full inline-flex"
                >
                  <span className="truncate">{displayName}</span>
                </Badge>
              </div>
            </TooltipTrigger>
            <TooltipContent>{rawName}</TooltipContent>
          </Tooltip>
        );
      },
    },
    {
      id: "toolName",
      header: "Tool Name",
      cell: ({ row }) => {
        const fullName = row.original.toolCall?.name;
        if (!fullName) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        const { toolName } = parseFullToolName(fullName);
        return <code className="text-xs">{toolName || fullName}</code>;
      },
    },
    {
      id: "arguments",
      header: "Arguments",
      cell: ({ row }) => {
        const args = row.original.toolCall?.arguments;
        if (!args) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        const argsString = JSON.stringify(args);
        return (
          <div className="text-xs font-mono">
            <TruncatedText message={argsString} maxLength={60} />
          </div>
        );
      },
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => {
        const result = row.original.toolResult;
        const method = row.original.method || "tools/call";

        // For tools/call, check isError
        if (
          method === "tools/call" &&
          result &&
          typeof result === "object" &&
          "isError" in result
        ) {
          const isError = (result as { isError: boolean }).isError;
          return (
            <Badge
              variant={isError ? "destructive" : "default"}
              className="text-xs whitespace-nowrap"
            >
              {isError ? "Error" : "Success"}
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
  ];

  const hasFilters =
    profileFilter !== "all" ||
    dateTimePicker.dateRange !== undefined ||
    searchFilter !== "";

  // Shared date picker component
  const datePickerComponent = (
    <DateTimeRangePicker
      dateRange={dateTimePicker.dateRange}
      isDialogOpen={dateTimePicker.isDateDialogOpen}
      tempDateRange={dateTimePicker.tempDateRange}
      fromTime={dateTimePicker.fromTime}
      toTime={dateTimePicker.toTime}
      displayText={dateTimePicker.getDateRangeDisplay()}
      onDialogOpenChange={dateTimePicker.setIsDateDialogOpen}
      onTempDateRangeChange={dateTimePicker.setTempDateRange}
      onFromTimeChange={dateTimePicker.setFromTime}
      onToTimeChange={dateTimePicker.setToTime}
      onOpenDialog={dateTimePicker.openDateDialog}
      onApply={dateTimePicker.handleApplyDateRange}
      idPrefix="mcp-gateway-"
    />
  );

  // Shared search input component
  const searchInputComponent = (
    <div className="relative w-[250px]">
      <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
      <DebouncedInput
        initialValue={searchFromUrl || ""}
        onChange={handleSearchChange}
        placeholder="Search tools, servers..."
        className="pl-9"
        debounceMs={400}
      />
    </div>
  );

  if (!mcpToolCalls || mcpToolCalls.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4">
          {searchInputComponent}
          <SearchableSelect
            value={profileFilter}
            onValueChange={handleProfileFilterChange}
            placeholder="Filter by MCP Gateway"
            items={[
              { value: "all", label: "All MCP Gateways" },
              ...(agents?.map((agent) => ({
                value: agent.id,
                label: agent.name,
              })) || []),
            ]}
            className="w-[200px]"
          />
          {datePickerComponent}
        </div>

        <div className="text-center py-12">
          <p className="text-muted-foreground text-sm">
            {hasFilters
              ? "No MCP tool calls match your filters. Try adjusting your search."
              : "No MCP tool calls found. Tool calls will appear here when agents use MCP tools."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        {searchInputComponent}
        <SearchableSelect
          value={profileFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by MCP Gateway"
          items={[
            { value: "all", label: "All MCP Gateways" },
            ...(agents?.map((agent) => ({
              value: agent.id,
              label: agent.name,
            })) || []),
          ]}
          className="w-[200px]"
        />
        {datePickerComponent}

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              handleSearchChange("");
              handleProfileFilterChange("all");
              dateTimePicker.clearDateRange();
            }}
          >
            Clear all filters
          </Button>
        )}
      </div>

      <DataTable
        columns={columns}
        data={mcpToolCalls}
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
        onPaginationChange={(newPagination) => {
          setPagination(newPagination);
        }}
        manualSorting
        sorting={sorting}
        onSortingChange={setSorting}
        onRowClick={(row) => {
          router.push(`/logs/mcp-gateway/${row.id}`);
        }}
      />
    </div>
  );
}
