"use client";

import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, Unplug } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useAgentToolPatchMutation,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import type { GetAllAgentToolsResponses } from "@/lib/clients/api";
import {
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import { formatDate } from "@/lib/utils";

type AgentToolData = GetAllAgentToolsResponses["200"][number];
type ToolResultTreatment = AgentToolData["toolResultTreatment"];

interface AssignedToolsListProps {
  agentTools: AgentToolData[];
  onToolClick: (tool: AgentToolData) => void;
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

export function AssignedToolsList({
  agentTools,
  onToolClick,
}: AssignedToolsListProps) {
  const agentToolPatchMutation = useAgentToolPatchMutation();
  const unassignToolMutation = useUnassignTool();
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const { data: resultPolicies } = useToolResultPolicies();

  const [searchQuery, setSearchQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([
    { id: "createdAt", desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<AgentToolData[]>([]);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "50");

  const filteredAgentTools = useMemo(() => {
    if (!searchQuery.trim()) return agentTools;

    const query = searchQuery.toLowerCase();
    return agentTools.filter((agentTool) =>
      agentTool.tool?.name.toLowerCase().includes(query),
    );
  }, [agentTools, searchQuery]);

  const sortedAndFilteredTools = useMemo(() => {
    if (sorting.length === 0) return filteredAgentTools;

    const sorted = [...filteredAgentTools].sort((a, b) => {
      for (const sort of sorting) {
        let aValue: string | number;
        let bValue: string | number;

        switch (sort.id) {
          case "name":
            aValue = a.tool.name;
            bValue = b.tool.name;
            break;
          case "agent":
            aValue = a.agent?.name || "";
            bValue = b.agent?.name || "";
            break;
          case "origin":
            aValue = a.tool.mcpServerName ? "1-mcp" : "2-intercepted";
            bValue = b.tool.mcpServerName ? "1-mcp" : "2-intercepted";
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
  }, [filteredAgentTools, sorting]);

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

  const handleBulkAction = useCallback(
    (
      field: "allowUsageWhenUntrustedDataIsPresent" | "toolResultTreatment",
      value: boolean | "trusted" | "sanitize_with_dual_llm" | "untrusted",
    ) => {
      selectedTools.forEach((tool) => {
        if (field === "allowUsageWhenUntrustedDataIsPresent") {
          const hasCustomInvocationPolicy =
            invocationPolicies?.byAgentToolId[tool.id]?.length > 0;
          if (hasCustomInvocationPolicy) {
            return;
          }
        }

        if (field === "toolResultTreatment") {
          const hasCustomResultPolicy =
            resultPolicies?.byAgentToolId[tool.id]?.length > 0;
          if (hasCustomResultPolicy) {
            return;
          }
        }

        agentToolPatchMutation.mutate({
          id: tool.id,
          [field]: value,
        });
      });
    },
    [selectedTools, agentToolPatchMutation, invocationPolicies, resultPolicies],
  );

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectedTools([]);
  }, []);

  const columns: ColumnDef<AgentToolData>[] = useMemo(
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
            aria-label={`Select ${row.original.tool.name}`}
          />
        ),
        size: 50,
      },
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
        cell: ({ row }) => (
          <div className="font-medium text-foreground truncate">
            {row.original.tool.name}
          </div>
        ),
        size: 250,
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
          const isMcpTool = !!row.original.tool.mcpServerName;
          const agentName = row.original.agent?.name || "-";

          if (!isMcpTool) {
            return <TruncatedText message={agentName} />;
          }

          const handleUnassign = async (e: React.MouseEvent) => {
            e.stopPropagation();

            try {
              await unassignToolMutation.mutateAsync({
                agentId: row.original.agent.id,
                toolId: row.original.tool.id,
              });
              toast.success("Tool unassigned from agent");
            } catch (error) {
              toast.error("Failed to unassign tool");
              console.error("Unassign error:", error);
            }
          };

          return (
            <div className="flex items-center gap-2">
              <TruncatedText message={agentName} />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={handleUnassign}
                      disabled={unassignToolMutation.isPending}
                      className="text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                    >
                      <Unplug className="h-4 w-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Unassign from agent</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          );
        },
        size: 150,
      },
      {
        id: "origin",
        accessorFn: (row) =>
          row.tool.mcpServerName ? "1-mcp" : "2-intercepted",
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
          const mcpServerName = row.original.tool.mcpServerName;

          if (mcpServerName) {
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="default"
                      className="bg-indigo-500 max-w-[120px]"
                    >
                      <span className="truncate">{mcpServerName}</span>
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>MCP Server: {mcpServerName}</p>
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
      {
        id: "allowWithUntrusted",
        header: "In untrusted context",
        cell: ({ row }) => {
          const hasCustomPolicy =
            invocationPolicies?.byAgentToolId[row.original.id]?.length > 0;

          if (hasCustomPolicy) {
            return (
              <span className="text-xs font-medium text-primary">Custom</span>
            );
          }

          return (
            <div className="flex items-center gap-2">
              <Switch
                checked={row.original.allowUsageWhenUntrustedDataIsPresent}
                onCheckedChange={(checked) => {
                  agentToolPatchMutation.mutate({
                    id: row.original.id,
                    allowUsageWhenUntrustedDataIsPresent: checked,
                  });
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Allow ${row.original.tool.name} in untrusted context`}
              />
              <span className="text-xs text-muted-foreground">
                {row.original.allowUsageWhenUntrustedDataIsPresent
                  ? "Allowed"
                  : "Blocked"}
              </span>
            </div>
          );
        },
        size: 120,
      },
      {
        id: "toolResultTreatment",
        header: "Results are",
        cell: ({ row }) => {
          const hasCustomPolicy =
            resultPolicies?.byAgentToolId[row.original.id]?.length > 0;

          if (hasCustomPolicy) {
            return (
              <span className="text-xs font-medium text-primary">Custom</span>
            );
          }

          const treatmentLabels: Record<ToolResultTreatment, string> = {
            trusted: "Trusted",
            untrusted: "Untrusted",
            sanitize_with_dual_llm: "Sanitize with Dual LLM",
          };

          return (
            <Select
              value={row.original.toolResultTreatment}
              onValueChange={(value: ToolResultTreatment) => {
                agentToolPatchMutation.mutate({
                  id: row.original.id,
                  toolResultTreatment: value,
                });
              }}
            >
              <SelectTrigger
                className="h-8 w-[180px] text-xs"
                onClick={(e) => e.stopPropagation()}
              >
                <SelectValue>
                  {treatmentLabels[row.original.toolResultTreatment]}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {Object.entries(treatmentLabels).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          );
        },
        size: 200,
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
    ],
    [
      invocationPolicies,
      resultPolicies,
      agentToolPatchMutation,
      unassignToolMutation,
    ],
  );

  const hasSelection = selectedTools.length > 0;

  return (
    <div className="space-y-6">
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              In untrusted context:
            </span>
            <ButtonGroup>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction("allowUsageWhenUntrustedDataIsPresent", true)
                }
                disabled={!hasSelection}
              >
                Allow
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction(
                    "allowUsageWhenUntrustedDataIsPresent",
                    false,
                  )
                }
                disabled={!hasSelection}
              >
                Block
              </Button>
            </ButtonGroup>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Results are:</span>
            <TooltipProvider>
              <ButtonGroup>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    handleBulkAction("toolResultTreatment", "trusted")
                  }
                  disabled={!hasSelection}
                >
                  Trusted
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    handleBulkAction("toolResultTreatment", "untrusted")
                  }
                  disabled={!hasSelection}
                >
                  Untrusted
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        handleBulkAction(
                          "toolResultTreatment",
                          "sanitize_with_dual_llm",
                        )
                      }
                      disabled={!hasSelection}
                    >
                      Dual LLM
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Sanitize with Dual LLM</p>
                  </TooltipContent>
                </Tooltip>
              </ButtonGroup>
            </TooltipProvider>
          </div>
          <div className="ml-2 h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            onClick={clearSelection}
            disabled={!hasSelection}
          >
            Clear selection
          </Button>
        </div>
      </div>

      {filteredAgentTools.length === 0 && searchQuery ? (
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
          onRowClick={(tool, event) => {
            const target = event.target as HTMLElement;
            const isCheckboxClick =
              target.closest('[data-column-id="select"]') ||
              target.closest('input[type="checkbox"]') ||
              target.closest('button[role="checkbox"]') ||
              target.closest('button[role="switch"]');
            if (!isCheckboxClick) {
              onToolClick(tool);
            }
          }}
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
