"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import { useProfiles } from "@/lib/agent.query";
import { useMcpToolCalls } from "@/lib/mcp-tool-call.query";

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

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search");
  const sortByFromUrl = searchParams.get("sortBy");
  const sortDirectionFromUrl = searchParams.get("sortDirection");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);

  const [searchQuery, setSearchQuery] = useState(searchFromUrl || "");
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || "createdAt",
      desc: sortDirectionFromUrl !== "asc",
    },
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

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      updateUrlParams({
        search: value || null,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const handleSortingChange = useCallback(
    (newSorting: SortingState) => {
      setSorting(newSorting);
      if (newSorting.length > 0) {
        updateUrlParams({
          sortBy: newSorting[0].id,
          sortDirection: newSorting[0].desc ? "desc" : "asc",
        });
      }
    },
    [updateUrlParams],
  );

  // Convert TanStack sorting to API format
  const sortBy = sorting[0]?.id;
  const sortDirection = sorting[0]?.desc ? "desc" : "asc";
  // Map UI column ids to API sort fields
  const apiSortBy: NonNullable<
    archestraApiTypes.GetMcpToolCallsData["query"]
  >["sortBy"] =
    sortBy === "agent"
      ? "agentId"
      : sortBy === "mcpServerName"
        ? "mcpServerName"
        : sortBy === "method"
          ? "method"
          : sortBy === "createdAt"
            ? "createdAt"
            : undefined;

  const { data: mcpToolCallsResponse } = useMcpToolCalls({
    limit: pageSize,
    offset: pageIndex * pageSize,
    sortBy: apiSortBy,
    sortDirection,
    search: searchQuery || undefined,
    initialData: initialData?.mcpToolCalls,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

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
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Profile
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        const agent = agents?.find((a) => a.id === row.original.agentId);
        return (
          <TruncatedText message={agent?.name ?? "Unknown"} maxLength={30} />
        );
      },
    },
    {
      id: "mcpServerName",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            MCP Server
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        return (
          <Badge variant="secondary" className="text-xs whitespace-normal">
            <TruncatedText
              message={row.original.mcpServerName}
              maxLength={15}
            />
          </Badge>
        );
      },
    },
    {
      id: "toolName",
      header: "Tool Name",
      cell: ({ row }) => {
        const toolName = row.original.toolCall?.name;
        if (!toolName) {
          return <div className="text-xs text-muted-foreground">—</div>;
        }
        return (
          <div className="text-xs">
            <TruncatedText message={toolName} maxLength={40} />
          </div>
        );
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
    {
      id: "result",
      header: "Result",
      cell: ({ row }) => {
        const result = row.original.toolResult;
        const method = row.original.method || "tools/call";

        // Handle tools/call with standard result structure
        if (
          method === "tools/call" &&
          result &&
          typeof result === "object" &&
          "isError" in result
        ) {
          const toolResult = result as {
            isError: boolean;
            error?: string;
            content?: unknown;
          };
          if (toolResult.isError) {
            return (
              <div className="text-xs text-destructive">
                <TruncatedText
                  message={toolResult.error || "Unknown error"}
                  maxLength={60}
                />
              </div>
            );
          }
          const contentString =
            typeof toolResult.content === "string"
              ? toolResult.content
              : JSON.stringify(toolResult.content);
          return (
            <div className="text-xs">
              <TruncatedText message={contentString} maxLength={60} />
            </div>
          );
        }

        // For other methods, just stringify the result
        const resultString =
          typeof result === "string" ? result : JSON.stringify(result);
        return (
          <div className="text-xs">
            <TruncatedText message={resultString} maxLength={60} />
          </div>
        );
      },
    },
  ];

  const hasFilters = searchQuery.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <div className="relative w-[300px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tools, arguments, and results..."
            value={searchQuery}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="pl-9 pr-9"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => handleSearchChange("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              handleSearchChange("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {!mcpToolCalls || mcpToolCalls.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters
            ? "No MCP tool calls match your search. Try adjusting your search."
            : "No MCP tool calls found. Tool calls will appear here when agents use MCP tools."}
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={mcpToolCalls}
          pagination={
            paginationMeta
              ? {
                  pageIndex,
                  pageSize,
                  total: paginationMeta.total,
                }
              : undefined
          }
          manualPagination
          onPaginationChange={handlePaginationChange}
          manualSorting
          sorting={sorting}
          onSortingChange={handleSortingChange}
        />
      )}
    </div>
  );
}
