"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useAgents } from "@/lib/agent.query";
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
    agents: archestraApiTypes.GetAgentsResponses["200"];
  };
}) {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
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
    agents: archestraApiTypes.GetAgentsResponses["200"];
  };
}) {
  const [pagination, setPagination] = useState({
    pageIndex: 0,
    pageSize: DEFAULT_TABLE_LIMIT,
  });
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

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
        : sortBy === "createdAt"
          ? "createdAt"
          : undefined;

  const { data: mcpToolCallsResponse } = useMcpToolCalls({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortBy: apiSortBy,
    sortDirection,
    initialData: initialData?.mcpToolCalls,
  });

  const { data: agents = [] } = useAgents({
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
            date: new Date(row.original.createdAt).toLocaleDateString(),
          })}
        </div>
      ),
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
            Agent
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
            {row.original.mcpServerName}
          </Badge>
        );
      },
    },
    {
      id: "toolName",
      header: "Tool Name",
      cell: ({ row }) => {
        return (
          <div className="text-xs">
            <TruncatedText
              message={row.original.toolCall.name}
              maxLength={40}
            />
          </div>
        );
      },
    },
    {
      id: "arguments",
      header: "Arguments",
      cell: ({ row }) => {
        const argsString = JSON.stringify(row.original.toolCall.arguments);
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
        const isError = row.original.toolResult.isError;
        return (
          <Badge
            variant={isError ? "destructive" : "default"}
            className="text-xs whitespace-nowrap"
          >
            {isError ? "Error" : "Success"}
          </Badge>
        );
      },
    },
    {
      id: "result",
      header: "Result",
      cell: ({ row }) => {
        const result = row.original.toolResult;
        if (result.isError) {
          return (
            <div className="text-xs text-destructive">
              <TruncatedText
                message={result.error || "Unknown error"}
                maxLength={60}
              />
            </div>
          );
        }
        const contentString =
          typeof result.content === "string"
            ? result.content
            : JSON.stringify(result.content);
        return (
          <div className="text-xs">
            <TruncatedText message={contentString} maxLength={60} />
          </div>
        );
      },
    },
  ];

  if (!mcpToolCalls || mcpToolCalls.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-muted-foreground text-sm">
          No MCP tool calls found. Tool calls will appear here when agents use
          MCP tools.
        </p>
      </div>
    );
  }

  return (
    <DataTable
      columns={columns}
      data={mcpToolCalls}
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
    />
  );
}
