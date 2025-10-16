"use client";

import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronRightIcon, ChevronUp } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { useAgents } from "@/lib/agent.query";
import type {
  GetAgentsResponses,
  GetInteractionsData,
  GetInteractionsResponses,
} from "@/lib/clients/api";
import { useInteractions } from "@/lib/interaction.query";

import { DynamicInteraction } from "@/lib/interaction.utils";

import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../_parts/error-boundary";

type InteractionData = GetInteractionsResponses["200"]["data"][number];

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

export default function LogsPage({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
  };
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-4 py-8 md:px-8">
          <h1 className="mb-2 text-2xl font-semibold tracking-tight">Logs</h1>
          <p className="text-sm text-muted-foreground">
            View all interactions between your agents and LLMs, including
            requests, responses, and tool invocations.
          </p>
        </div>
      </div>

      <div className="mx-auto w-full max-w-7xl px-4 py-8 md:px-8">
        <ErrorBoundary>
          <LogsTable initialData={initialData} />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function LogsTable({
  initialData,
}: {
  initialData?: {
    interactions: GetInteractionsResponses["200"];
    agents: GetAgentsResponses["200"];
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
  const apiSortBy: NonNullable<GetInteractionsData["query"]>["sortBy"] =
    sortBy === "agent"
      ? "agentId"
      : sortBy === "request.model"
        ? "model"
        : sortBy === "createdAt"
          ? "createdAt"
          : undefined;

  const { data: interactionsResponse } = useInteractions({
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
    sortBy: apiSortBy,
    sortDirection,
    initialData: initialData?.interactions,
  });

  const { data: agents = [] } = useAgents({
    initialData: initialData?.agents,
  });

  const interactions = interactionsResponse?.data ?? [];
  const paginationMeta = interactionsResponse?.pagination;

  const columns: ColumnDef<InteractionData>[] = [
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
          {formatDate({ date: new DynamicInteraction(row.original).createdAt })}
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
        const interaction = new DynamicInteraction(row.original);
        const agent = agents?.find((a) => a.id === interaction.agentId);
        return (
          <TruncatedText message={agent?.name ?? "Unknown"} maxLength={30} />
        );
      },
    },
    {
      accessorKey: "request.model",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Provider + Model
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        const interaction = new DynamicInteraction(row.original);
        return (
          <Badge variant="secondary" className="text-xs">
            {interaction.provider} ({interaction.modelName})
          </Badge>
        );
      },
    },
    {
      id: "userMessage",
      header: "User Message",
      cell: ({ row }) => {
        const userMessage = new DynamicInteraction(
          row.original,
        ).getLastUserMessage();
        return (
          <div className="text-xs">
            <TruncatedText message={userMessage} maxLength={80} />
          </div>
        );
      },
    },
    {
      id: "assistantResponse",
      header: "Assistant Response",
      cell: ({ row }) => {
        const assistantResponse = new DynamicInteraction(
          row.original,
        ).getLastAssistantResponse();
        return (
          <div className="text-xs">
            <TruncatedText message={assistantResponse} maxLength={80} />
          </div>
        );
      },
    },
    {
      id: "tools",
      header: "Tools",
      cell: ({ row }) => {
        const interaction = new DynamicInteraction(row.original);
        const toolsUsed = interaction.getToolNamesUsed();
        const toolsBlocked = interaction.getToolNamesRefused();

        if (toolsUsed.length === 0 && toolsBlocked.length === 0) {
          return <span className="text-xs text-muted-foreground">None</span>;
        }

        return (
          <div className="flex flex-wrap gap-1">
            {toolsUsed.map((toolName) => (
              <Badge
                key={`used-${toolName}`}
                variant="default"
                className="whitespace-nowrap text-xs"
              >
                ✓ {toolName}
              </Badge>
            ))}
            {toolsBlocked.map((toolName) => (
              <Badge
                key={`blocked-${toolName}`}
                variant="destructive"
                className="whitespace-nowrap text-xs"
              >
                ✗ {toolName}
              </Badge>
            ))}
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <Link
          href={`/logs/${new DynamicInteraction(row.original).id}`}
          className="flex items-center gap-1 whitespace-nowrap text-sm text-primary hover:underline"
        >
          View
          <ChevronRightIcon className="h-3 w-3" />
        </Link>
      ),
    },
  ];

  if (!interactions || interactions.length === 0) {
    return <p className="text-muted-foreground">No logs found</p>;
  }

  return (
    <DataTable
      columns={columns}
      data={interactions}
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
