"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { DebouncedInput } from "@/components/debounced-input";
import { Badge } from "@/components/ui/badge";
import { DataTable } from "@/components/ui/data-table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAgents } from "@/lib/agent.query";
import { useTools } from "@/lib/tool.query";
import { isMcpTool } from "@/lib/tool.utils";
import { formatDate } from "@/lib/utils";

type ToolRow = archestraApiTypes.GetToolsResponses["200"]["data"][number];

interface AssignedToolsTableProps {
  onToolClick: (tool: ToolRow) => void;
}

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  if (isSorted === "asc") return <ChevronUp className="h-3 w-3" />;
  if (isSorted === "desc") return <ChevronDown className="h-3 w-3" />;
  return (
    <div className="text-muted-foreground/50 flex flex-col items-center">
      <ChevronUp className="h-3 w-3" />
      <span className="mt-[-4px]">
        <ChevronDown className="h-3 w-3" />
      </span>
    </div>
  );
}

export function AssignedToolsTable({ onToolClick }: AssignedToolsTableProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search");
  const agentIdFromUrl = searchParams.get("agentId");
  const originFromUrl = searchParams.get("origin");
  const sortByFromUrl = searchParams.get("sortBy");
  const sortDirectionFromUrl = searchParams.get("sortDirection");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "20");

  const [searchQuery, setSearchQuery] = useState(searchFromUrl || "");
  const [agentFilter, setAgentFilter] = useState(agentIdFromUrl || "all");
  const [originFilter, setOriginFilter] = useState(originFromUrl || "all");
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || "createdAt",
      desc: sortDirectionFromUrl !== "asc",
    },
  ]);

  const { data: agents } = useAgents();

  const { data: toolsData, isLoading } = useTools({
    pagination: {
      limit: pageSize,
      offset: pageIndex * pageSize,
    },
    sorting: {
      sortBy:
        (sorting[0]?.id as NonNullable<
          archestraApiTypes.GetToolsData["query"]
        >["sortBy"]) || "createdAt",
      sortDirection: sorting[0]?.desc ? "desc" : "asc",
    },
    filters: {
      search: searchQuery || undefined,
      agentId: agentFilter !== "all" ? agentFilter : undefined,
      origin:
        originFilter !== "all"
          ? (originFilter as NonNullable<
              archestraApiTypes.GetToolsData["query"]
            >["origin"])
          : undefined,
      excludeArchestraTools: true,
    },
  });

  const tools = toolsData?.data ?? [];
  const pagination = toolsData?.pagination;

  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (!value || value === "all") {
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

  const columns = useMemo<ColumnDef<ToolRow>[]>(
    () => [
      {
        accessorKey: "name",
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 text-left font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Tool
            <SortIcon isSorted={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => {
          const tool = row.original;
          return (
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="text-left font-medium">{tool.name}</span>
                {isMcpTool(tool) ? (
                  <Badge variant="outline" className="bg-indigo-500/10 text-xs">
                    MCP Server
                  </Badge>
                ) : (
                  <Badge variant="outline" className="bg-orange-500/10 text-xs">
                    Intercepted
                  </Badge>
                )}
              </div>
            </div>
          );
        },
        size: 350,
      },
      {
        id: "origin",
        header: "Origin",
        cell: ({ row }) => {
          const tool = row.original;
          if (isMcpTool(tool)) {
            return (
              <div className="flex flex-col">
                <span className="text-sm font-medium text-foreground">
                  MCP Catalog
                </span>
                {tool.mcpServer?.name && (
                  <span className="text-xs text-muted-foreground">
                    {tool.mcpServer.name}
                  </span>
                )}
              </div>
            );
          }
          return (
            <div className="flex flex-col">
              <span className="text-sm font-medium text-foreground">
                LLM Proxy
              </span>
              {tool.agent?.name && (
                <span className="text-xs text-muted-foreground">
                  {tool.agent.name}
                </span>
              )}
            </div>
          );
        },
      },
      {
        accessorKey: "assignedAgentsCount",
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Profiles
            <SortIcon isSorted={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => (
          <div className="text-center font-medium">
            {row.original.assignedAgentsCount}
          </div>
        ),
      },
      {
        accessorKey: "policyCount",
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Policies
            <SortIcon isSorted={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => (
          <div className="text-center font-medium">
            {row.original.policyCount}
          </div>
        ),
      },
      {
        accessorKey: "updatedAt",
        header: ({ column }) => (
          <button
            type="button"
            className="flex items-center gap-1 font-semibold"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Updated
            <SortIcon isSorted={column.getIsSorted()} />
          </button>
        ),
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatDate({ date: row.original.updatedAt })}
          </span>
        ),
      },
    ],
    [],
  );

  if (isLoading && !tools.length) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex w-full flex-col gap-4 md:flex-row">
          <div className="md:w-80">
            <DebouncedInput
              key={`tools-search-${searchQuery}`}
              placeholder="Search tools"
              initialValue={searchQuery}
              onChange={(value) => {
                setSearchQuery(value);
                updateUrlParams({ search: value || null, page: "1" });
              }}
            />
          </div>
          <Select
            value={agentFilter}
            onValueChange={(value) => {
              setAgentFilter(value);
              updateUrlParams({
                agentId: value === "all" ? null : value,
                page: "1",
              });
            }}
          >
            <SelectTrigger className="md:w-60">
              <SelectValue placeholder="Filter by profile" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Profiles</SelectItem>
              {agents?.map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>
                  {agent.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={originFilter}
            onValueChange={(value) => {
              setOriginFilter(value);
              updateUrlParams({
                origin: value === "all" ? null : value,
                page: "1",
              });
            }}
          >
            <SelectTrigger className="md:w-48">
              <SelectValue placeholder="Origin" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Origins</SelectItem>
              <SelectItem value="mcp">MCP Servers</SelectItem>
              <SelectItem value="llm-proxy">LLM Proxy</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={tools}
        manualPagination
        manualSorting
        sorting={sorting}
        onSortingChange={(state) => {
          setSorting(state);
          const primary = state[0];
          updateUrlParams({
            sortBy: primary?.id ?? null,
            sortDirection: primary ? (primary.desc ? "desc" : "asc") : null,
          });
        }}
        pagination={{
          pageIndex,
          pageSize,
          total: pagination?.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
        onRowClick={(tool) => onToolClick(tool)}
      />
    </div>
  );
}
