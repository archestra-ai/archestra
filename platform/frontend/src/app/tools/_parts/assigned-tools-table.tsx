"use client";

import type { archestraApiTypes } from "@shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Search, Unplug } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import { InstallationSelect } from "@/components/installation-select";
import { TokenSelect } from "@/components/token-select";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
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
import { useAgents } from "@/lib/agent.query";
import {
  useAgentToolPatchMutation,
  useAllAgentTools,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp-server.query";
import {
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import { isMcpTool } from "@/lib/tool.utils";

type GetAllAgentToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;
type AgentToolsSortByValues = NonNullable<
  GetAllAgentToolsQueryParams["sortBy"]
> | null;
type AgentToolsSortDirectionValues = NonNullable<
  GetAllAgentToolsQueryParams["sortDirection"]
> | null;

type AgentToolData =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
type ToolResultTreatment = AgentToolData["toolResultTreatment"];

interface AssignedToolsTableProps {
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

export function AssignedToolsTable({ onToolClick }: AssignedToolsTableProps) {
  const agentToolPatchMutation = useAgentToolPatchMutation();
  const unassignToolMutation = useUnassignTool();
  const { data: invocationPolicies } = useToolInvocationPolicies();
  const { data: resultPolicies } = useToolResultPolicies();
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog();
  const { data: agents } = useAgents();
  const { data: mcpServers } = useMcpServers();

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search");
  const agentIdFromUrl = searchParams.get("agentId");
  const originFromUrl = searchParams.get("origin");
  const credentialFromUrl = searchParams.get("credential");
  const sortByFromUrl = searchParams.get("sortBy") as AgentToolsSortByValues;
  const sortDirectionFromUrl = searchParams.get(
    "sortDirection",
  ) as AgentToolsSortDirectionValues;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || "50");

  // State
  const [searchQuery, setSearchQuery] = useState(searchFromUrl || "");
  const [agentFilter, setAgentFilter] = useState(agentIdFromUrl || "all");
  const [originFilter, setOriginFilter] = useState(originFromUrl || "all");
  const [credentialFilter, setCredentialFilter] = useState(
    credentialFromUrl || "all",
  );
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || "createdAt",
      desc: sortDirectionFromUrl !== "asc",
    },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<AgentToolData[]>([]);

  // Fetch agent tools with server-side pagination, filtering, and sorting
  const { data: agentToolsData } = useAllAgentTools({
    pagination: {
      limit: pageSize,
      offset: pageIndex * pageSize,
    },
    sorting: {
      sortBy: (sorting[0]?.id as AgentToolsSortByValues) || "createdAt",
      sortDirection: sorting[0]?.desc ? "desc" : "asc",
    },
    filters: {
      search: searchQuery || undefined,
      agentId: agentFilter !== "all" ? agentFilter : undefined,
      origin: originFilter !== "all" ? originFilter : undefined,
      credentialSourceMcpServerId:
        credentialFilter !== "all" ? credentialFilter : undefined,
    },
  });

  const agentTools = agentToolsData.data;
  const paginationMeta = agentToolsData.pagination;

  // Helper to update URL params
  const updateUrlParams = useCallback(
    (updates: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      Object.entries(updates).forEach(([key, value]) => {
        if (value === null || value === "" || value === "all") {
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
      setRowSelection({});
      setSelectedTools([]);

      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams],
  );

  const handleRowSelectionChange = useCallback(
    (newRowSelection: RowSelectionState) => {
      setRowSelection(newRowSelection);

      const newSelectedTools = Object.keys(newRowSelection)
        .map((index) => agentTools[Number(index)])
        .filter(Boolean);

      setSelectedTools(newSelectedTools);
    },
    [agentTools],
  );

  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      updateUrlParams({
        search: value || null,
        page: "1", // Reset to first page
      });
      setRowSelection({});
      setSelectedTools([]);
    },
    [updateUrlParams],
  );

  const handleAgentFilterChange = useCallback(
    (value: string) => {
      setAgentFilter(value);
      updateUrlParams({
        agentId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
      setRowSelection({});
      setSelectedTools([]);
    },
    [updateUrlParams],
  );

  const handleOriginFilterChange = useCallback(
    (value: string) => {
      setOriginFilter(value);
      updateUrlParams({
        origin: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
      setRowSelection({});
      setSelectedTools([]);
    },
    [updateUrlParams],
  );

  const handleCredentialFilterChange = useCallback(
    (value: string) => {
      setCredentialFilter(value);
      updateUrlParams({
        credential: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
      setRowSelection({});
      setSelectedTools([]);
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
        size: 30,
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
          <TruncatedText
            message={row.original.tool.name}
            className="break-all"
            maxLength={25}
          />
        ),
        size: 130,
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
          const agentName = row.original.agent?.name || "-";

          const TruncatedAgentName = (
            <TruncatedText message={agentName} maxLength={30} />
          );

          if (!isMcpTool(row.original.tool)) {
            return TruncatedAgentName;
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
              {TruncatedAgentName}
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
        accessorFn: (row) => (isMcpTool(row.tool) ? "1-mcp" : "2-intercepted"),
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
          const catalogItemId = row.original.tool.catalogId;
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
        size: 100,
      },
      {
        id: "token",
        header: "Credential",
        cell: ({ row }) => {
          // Only show selector for MCP tools
          if (!isMcpTool(row.original.tool)) {
            return <span className="text-sm text-muted-foreground">—</span>;
          }

          // Determine if tool is from local server using catalog
          const mcpCatalogItem = internalMcpCatalogItems?.find(
            (item) => item.id === row.original.tool.catalogId,
          );
          const isLocalServer = mcpCatalogItem?.serverType === "local";

          // Show InstallationSelect for local servers, TokenSelect for remote
          if (isLocalServer) {
            return (
              <InstallationSelect
                value={row.original.executionSourceMcpServerId}
                onValueChange={(value) => {
                  // Prevent clearing required field
                  if (value !== null) {
                    agentToolPatchMutation.mutate({
                      id: row.original.id,
                      executionSourceMcpServerId: value,
                    });
                  }
                }}
                catalogId={row.original.tool.catalogId ?? ""}
                agentIds={[row.original.agent.id]}
                className="h-8 w-[200px] text-xs"
              />
            );
          }

          return (
            <TokenSelect
              value={row.original.credentialSourceMcpServerId}
              onValueChange={(value) => {
                // Prevent clearing required field
                if (value !== null) {
                  agentToolPatchMutation.mutate({
                    id: row.original.id,
                    credentialSourceMcpServerId: value,
                  });
                }
              }}
              catalogId={row.original.tool.catalogId ?? ""}
              agentIds={[row.original.agent.id]}
              className="h-8 w-[200px] text-xs"
            />
          );
        },
        size: 120,
      },
      {
        id: "allowUsageWhenUntrustedDataIsPresent",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            In untrusted context
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
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
        size: 140,
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
                size="sm"
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
        size: 190,
      },
    ],
    [
      invocationPolicies,
      resultPolicies,
      agentToolPatchMutation,
      unassignToolMutation,
      internalMcpCatalogItems?.find,
    ],
  );

  const hasSelection = selectedTools.length > 0;

  // Get unique origins from internal MCP catalog
  const uniqueOrigins = useMemo(() => {
    const origins = new Set<{ id: string; name: string }>();
    internalMcpCatalogItems?.forEach((item) => {
      origins.add({ id: item.id, name: item.name });
    });
    return Array.from(origins);
  }, [internalMcpCatalogItems]);

  // Get unique credentials (MCP servers)
  const uniqueCredentials = useMemo(() => {
    return mcpServers || [];
  }, [mcpServers]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <DebouncedInput
            placeholder="Search tools by name..."
            initialValue={searchQuery}
            onChange={handleSearchChange}
            className="pl-9"
          />
        </div>

        <Select value={agentFilter} onValueChange={handleAgentFilterChange}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by Agent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Agents</SelectItem>
            {agents?.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={originFilter} onValueChange={handleOriginFilterChange}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by Origin" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Origins</SelectItem>
            <SelectItem value="llm-proxy">LLM Proxy</SelectItem>
            {uniqueOrigins.map((origin) => (
              <SelectItem key={origin.id} value={origin.id}>
                {origin.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={credentialFilter}
          onValueChange={handleCredentialFilterChange}
        >
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter by Credential" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Credentials</SelectItem>
            {uniqueCredentials.map((credential) => (
              <SelectItem key={credential.id} value={credential.id}>
                {credential.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
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

      {agentTools.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            {searchQuery ||
            agentFilter !== "all" ||
            originFilter !== "all" ||
            credentialFilter !== "all"
              ? "No tools match your filters. Try adjusting your search or filters."
              : "No tools have been assigned yet."}
          </p>
          {(searchQuery ||
            agentFilter !== "all" ||
            originFilter !== "all" ||
            credentialFilter !== "all") && (
            <Button
              variant="outline"
              onClick={() => {
                handleSearchChange("");
                handleAgentFilterChange("all");
                handleOriginFilterChange("all");
                handleCredentialFilterChange("all");
              }}
            >
              Clear all filters
            </Button>
          )}
        </div>
      ) : (
        <DataTable
          columns={columns}
          data={agentTools}
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
          onSortingChange={handleSortingChange}
          manualSorting={true}
          manualPagination={true}
          pagination={{
            pageIndex,
            pageSize,
            total: paginationMeta.total,
          }}
          onPaginationChange={handlePaginationChange}
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
        />
      )}
    </div>
  );
}
