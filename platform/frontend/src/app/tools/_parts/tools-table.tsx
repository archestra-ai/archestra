"use client";

import type { archestraApiTypes } from "@shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { isMcpTool } from "@/lib/tool.utils";

type ExtendedTool = archestraApiTypes.GetToolsResponses["200"][number];
type AgentData = archestraApiTypes.GetAllAgentsResponses["200"][number];

interface ToolsTableProps {
  tools: ExtendedTool[];
  agents: AgentData[];
  onBulkAssignTools: (tools: ExtendedTool[]) => void;
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

export function ToolsTable({
  tools,
  agents,
  onBulkAssignTools,
}: ToolsTableProps) {
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog();

  const [searchQuery, setSearchQuery] = useState("");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<ExtendedTool[]>([]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "50");

  const filteredTools = useMemo(() => {
    let filtered = tools;

    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((tool) =>
        tool.name.toLowerCase().includes(query),
      );
    }

    // Apply agent filter
    if (agentFilter !== "all") {
      if (agentFilter === "unassigned") {
        filtered = filtered.filter((tool) => !tool.agent);
      } else {
        filtered = filtered.filter((tool) => tool.agent?.id === agentFilter);
      }
    }

    return filtered;
  }, [tools, searchQuery, agentFilter]);

  const sortedAndFilteredTools = useMemo(() => {
    if (sorting.length === 0) return filteredTools;

    const sorted = [...filteredTools].sort((a, b) => {
      for (const sort of sorting) {
        let aValue: string | number;
        let bValue: string | number;

        switch (sort.id) {
          case "name":
            aValue = a.name;
            bValue = b.name;
            break;
          case "agent":
            aValue = a.agent?.name || "";
            bValue = b.agent?.name || "";
            break;
          case "origin":
            aValue = isMcpTool(a) ? "1-mcp" : "2-intercepted";
            bValue = isMcpTool(b) ? "1-mcp" : "2-intercepted";
            break;
          case "createdAt":
            aValue = a.createdAt;
            bValue = b.createdAt;
            break;
          default:
            continue;
        }

        if (aValue < bValue) return sort.desc ? 1 : -1;
        if (aValue > bValue) return sort.desc ? -1 : 1;
      }
      return 0;
    });

    return sorted;
  }, [filteredTools, sorting]);

  const paginatedTools = useMemo(() => {
    const startIndex = pageIndex * pageSize;
    const endIndex = startIndex + pageSize;
    return sortedAndFilteredTools.slice(startIndex, endIndex);
  }, [sortedAndFilteredTools, pageIndex, pageSize]);

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setRowSelection({});
      setSelectedTools([]);

      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleRowSelectionChange = useCallback(
    (newRowSelection: RowSelectionState) => {
      setRowSelection(newRowSelection);

      const startIndex = pageIndex * pageSize;
      const pageTools = sortedAndFilteredTools.slice(
        startIndex,
        startIndex + pageSize,
      );

      const newSelectedTools = Object.keys(newRowSelection)
        .map((index) => pageTools[Number(index)])
        .filter(Boolean);

      setSelectedTools(newSelectedTools);
    },
    [sortedAndFilteredTools, pageIndex, pageSize],
  );

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectedTools([]);
  }, []);

  const handleBulkAssign = () => {
    onBulkAssignTools(selectedTools);
  };

  const columns: ColumnDef<ExtendedTool>[] = useMemo(
    () => [
      {
        id: "select",
        header: ({ table }) => (
          <Checkbox
            checked={
              table.getIsAllPageRowsSelected() ||
              (table.getIsSomePageRowsSelected() && "indeterminate")
            }
            onCheckedChange={(value) =>
              table.toggleAllPageRowsSelected(!!value)
            }
            aria-label="Select all"
          />
        ),
        cell: ({ row }) => (
          <Checkbox
            checked={row.getIsSelected()}
            onCheckedChange={(value) => row.toggleSelected(!!value)}
            aria-label={`Select ${row.original.name}`}
          />
        ),
        size: 30,
      },
      {
        id: "name",
        accessorFn: (row) => row.name,
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
        cell: ({ row }) => (
          <TruncatedText message={row.original.name} className="break-all" />
        ),
        size: 200,
      },
      {
        id: "agent",
        accessorFn: (row) => row.agent?.name || "",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Agent
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const agentName = row.original.agent?.name || "Unassigned";
          return <TruncatedText message={agentName} />;
        },
        size: 150,
      },
      {
        id: "origin",
        accessorFn: (row) => (isMcpTool(row) ? "1-mcp" : "2-intercepted"),
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Origin
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const catalogItemId = row.original.catalogId;
          const catalogItem = internalMcpCatalogItems?.find(
            (item) => item.id === catalogItemId,
          );

          if (catalogItem) {
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="default"
                      className="bg-indigo-500 max-w-[100px]"
                    >
                      <span className="truncate">{catalogItem.name}</span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>{catalogItem.name}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            );
          }

          return (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="secondary"
                    className="bg-amber-700 text-white"
                  >
                    LLM Proxy
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Tool discovered via agent-LLM communication</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
        size: 120,
      },
    ],
    [internalMcpCatalogItems],
  );

  const hasSelection = selectedTools.length > 0;

  return (
    <div className="space-y-6">
      {/* Search and filters */}
      <div className="flex gap-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tools by name..."
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
              setRowSelection({});
              setSelectedTools([]);
            }}
            className="pl-9"
          />
        </div>

        <Select value={agentFilter} onValueChange={setAgentFilter}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Bulk actions bar */}
      <div className="flex items-center justify-between p-4 bg-muted/50 border border-border rounded-lg">
        <div className="flex items-center gap-3">
          {hasSelection ? (
            <>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                <span className="text-sm font-semibold text-primary">
                  {selectedTools.length}
                </span>
              </div>
              <span className="text-sm font-medium">
                {selectedTools.length === 1
                  ? "tool selected"
                  : "tools selected"}
              </span>
            </>
          ) : (
            <span className="text-sm text-muted-foreground">
              Select tools to apply bulk actions
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <Button
            size="sm"
            onClick={handleBulkAssign}
            disabled={!hasSelection}
            className="gap-2"
          >
            <Users className="h-4 w-4" />
            Assign to Agents
          </Button>
          {hasSelection && (
            <>
              <div className="h-4 w-px bg-border" />
              <Button size="sm" variant="ghost" onClick={clearSelection}>
                Clear selection
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Tools table */}
      {filteredTools.length === 0 && searchQuery ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            No tools match "{searchQuery}". Try adjusting your search.
          </p>
          <Button
            variant="outline"
            onClick={() => {
              setSearchQuery("");
              setRowSelection({});
              setSelectedTools([]);
            }}
          >
            Clear search
          </Button>
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={paginatedTools}
          sorting={sorting}
          onSortingChange={setSorting}
          manualSorting={true}
          manualPagination={true}
          pagination={{
            pageIndex,
            pageSize,
            total: sortedAndFilteredTools.length,
          }}
          onPaginationChange={handlePaginationChange}
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
        />
      )}
    </div>
  );
}
