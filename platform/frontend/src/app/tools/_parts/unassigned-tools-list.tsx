"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDate } from "@/lib/utils";

type ExtendedTool = archestraApiTypes.GetToolsResponses["200"][number];

export interface UnassignedToolData {
  id: string;
  tool: {
    id: string;
    name: string;
    description: string | null;
    parameters: Record<string, unknown> | null | undefined;
    createdAt: string;
    updatedAt: string;
    mcpServerId: string | null;
    mcpServerName: string | null;
    catalogId: string | null;
  };
  agent: null;
  createdAt: string;
  updatedAt: string;
}

interface UnassignedToolsListProps {
  tools: ExtendedTool[];
  onToolClick?: (tool: UnassignedToolData) => void;
  onAssignClick: (tool: UnassignedToolData) => void;
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

export function UnassignedToolsList({
  tools,
  onToolClick: _onToolClick,
  onAssignClick,
}: UnassignedToolsListProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "50");

  // Convert ExtendedTool to UnassignedToolData format
  const unassignedTools: UnassignedToolData[] = useMemo(() => {
    return tools.map((tool) => ({
      id: `unassigned-${tool.id}`,
      tool: {
        id: tool.id,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        createdAt: String(tool.createdAt),
        updatedAt: String(tool.updatedAt),
        mcpServerId: tool.mcpServer?.id || null,
        mcpServerName: tool.mcpServer?.name || null,
        catalogId: tool.catalogId,
      },
      agent: null,
      createdAt: String(tool.createdAt),
      updatedAt: String(tool.updatedAt),
    }));
  }, [tools]);

  const filteredTools = useMemo(() => {
    if (!searchQuery.trim()) return unassignedTools;

    const query = searchQuery.toLowerCase();
    return unassignedTools.filter((tool) => {
      // Create a comprehensive search string from tool name, description, and parameter keys
      const searchableText = [
        tool.tool.name,
        tool.tool.description || "",
        Object.keys(tool.tool.parameters?.properties || {}).join(" "),
      ]
        .join(" ")
        .toLowerCase();

      return searchableText.includes(query);
    });
  }, [unassignedTools, searchQuery]);

  const paginatedTools = useMemo(() => {
    const startIndex = pageIndex * pageSize;
    const endIndex = startIndex + pageSize;
    return filteredTools.slice(startIndex, endIndex);
  }, [filteredTools, pageIndex, pageSize]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const columns: ColumnDef<UnassignedToolData>[] = useMemo(
    () => [
      {
        id: "name",
        accessorFn: (row) => row.tool.name,
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Tool Name
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const tool = row.original.tool;

          if (!tool.description) {
            return (
              <div className="font-medium text-foreground truncate">
                {tool.name}
              </div>
            );
          }

          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="font-medium text-foreground truncate cursor-help">
                    {tool.name}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-md">
                  <p className="text-sm">{tool.description}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
        size: 250,
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Detected
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <div className="font-mono text-xs text-muted-foreground">
            {formatDate({ date: row.original.createdAt })}
          </div>
        ),
        size: 150,
      },
      {
        id: "parameters",
        header: "Parameters",
        cell: ({ row }) => {
          const tool = row.original.tool;
          const paramCount = Object.keys(
            tool.parameters?.properties || {},
          ).length;

          if (paramCount === 0) {
            return <span className="text-sm text-muted-foreground">None</span>;
          }

          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium">
                    {paramCount}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-md">
                  <div className="space-y-1">
                    {Object.entries(tool.parameters?.properties || {}).map(
                      ([key, value]: [string, { type?: string }]) => {
                        const isRequired = Array.isArray(
                          tool.parameters?.required,
                        )
                          ? tool.parameters.required.includes(key)
                          : false;
                        return (
                          <div key={key} className="text-xs">
                            <code className="font-medium">{key}</code>
                            <span className="text-green-700">
                              : {value.type}
                            </span>
                            {isRequired && (
                              <span className="text-green-700">
                                {" "}
                                (required)
                              </span>
                            )}
                          </div>
                        );
                      },
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
        size: 100,
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <Button
            size="sm"
            variant="outline"
            onClick={(e) => {
              e.stopPropagation();
              onAssignClick(row.original);
            }}
          >
            Assign Agents
          </Button>
        ),
        size: 150,
      },
    ],
    [onAssignClick],
  );

  return (
    <div className="space-y-6">
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search tools by name, description, or parameter names..."
          value={searchQuery}
          onChange={(e) => {
            setSearchQuery(e.target.value);
            if (pageIndex !== 0) {
              const params = new URLSearchParams(searchParams.toString());
              params.set("page", "1");
              router.push(`${pathname}?${params.toString()}`, {
                scroll: false,
              });
            }
          }}
          className="pl-9"
        />
      </div>

      {filteredTools.length === 0 && searchQuery ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            No tools match "{searchQuery}". Try adjusting your search.
          </p>
          <Button variant="outline" onClick={() => setSearchQuery("")}>
            Clear search
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={paginatedTools}
          sorting={sorting}
          onSortingChange={setSorting}
          manualPagination={true}
          pagination={{
            pageIndex,
            pageSize,
            total: filteredTools.length,
          }}
          onPaginationChange={handlePaginationChange}
        />
      )}
    </div>
  );
}
