"use client";

import {
  type archestraApiTypes,
  ClientFilterSchema,
  parseFullToolName,
} from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  AppWindow,
  Bot,
  ChevronDown,
  ChevronUp,
  Network,
  Pencil,
  Server,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { CallPolicyToggle } from "@/components/call-policy-toggle";
import { LoadingSpinner } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResultPolicyToggle } from "@/components/result-policy-toggle";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { ToolPolicyBulkActionsBar } from "@/components/tool-policy-bulk-actions";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ClientFilterSelect,
  UserFilterSelect,
} from "@/components/user-client-filter-selects";
import {
  DEFAULT_FILTER_ALL,
  DEFAULT_SORT_BY,
  DEFAULT_TABLE_LIMIT,
} from "@/consts";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useInternalMcpCatalog } from "@/lib/mcp/internal-mcp-catalog.query";
import {
  useCallPolicyMutation,
  useResultPolicyMutation,
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import {
  type CallPolicyAction,
  getCallPolicyActionFromPolicies,
  getResultPolicyActionFromPolicies,
  type ResultPolicyAction,
} from "@/lib/policy.utils";
import {
  type ToolWithAssignmentsData,
  useAllMatchingTools,
  useToolObservers,
  useToolsWithAssignments,
} from "@/lib/tools/tool.query";
import type { ToolsInitialData } from "../types";
import {
  APP_ORIGIN_FILTER_VALUE,
  APP_TOOL_SOURCE_DESCRIPTION,
  APP_TOOL_SOURCE_LABEL,
  getToolSource,
  getVisibleCatalogSources,
  hasAppCatalogSources,
  MCP_TOOL_SOURCE_LABEL,
  OBSERVED_TOOL_SOURCE_DESCRIPTION,
  OBSERVED_TOOL_SOURCE_LABEL,
} from "./assigned-tools-table.utils";

type GetToolsWithAssignmentsQueryParams = NonNullable<
  archestraApiTypes.GetToolsWithAssignmentsData["query"]
>;
type ToolsSortByValues = NonNullable<
  GetToolsWithAssignmentsQueryParams["sortBy"]
> | null;
type ToolsSortDirectionValues = NonNullable<
  GetToolsWithAssignmentsQueryParams["sortDirection"]
> | null;

interface AssignedToolsTableProps {
  onToolClick: (tool: ToolWithAssignmentsData) => void;
  initialData?: ToolsInitialData;
}

function SortIcon({
  isSorted,
}: {
  isSorted: NonNullable<ToolsSortDirectionValues> | false;
}) {
  if (isSorted === "asc") return <ChevronUp className="h-3 w-3" />;
  if (isSorted === "desc") return <ChevronDown className="h-3 w-3" />;

  return (
    <div className="text-muted-foreground flex flex-col items-center">
      <ChevronUp className="h-3 w-3" />
      <span className="mt-[-4px]">
        <ChevronDown className="h-3 w-3" />
      </span>
    </div>
  );
}

export function AssignedToolsTable({
  onToolClick,
  initialData,
}: AssignedToolsTableProps) {
  const callPolicyMutation = useCallPolicyMutation();
  const resultPolicyMutation = useResultPolicyMutation();
  const { data: invocationPolicies } = useToolInvocationPolicies(
    initialData?.toolInvocationPolicies,
  );
  const { data: resultPolicies } = useToolResultPolicies(
    initialData?.toolResultPolicies,
  );
  // App backings are catalogs too, and their launch tools are listed here — so
  // this page needs them to name the source of those rows.
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog({
    initialData: initialData?.internalMcpCatalog,
    includeApps: true,
  });

  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();

  // Get URL params
  const searchFromUrl = searchParams.get("search");
  const originFromUrl = searchParams.get("origin");
  const observedByFromUrl = searchParams.get("observedBy");
  const clientFromUrl = searchParams.get("client");
  const sortByFromUrl = searchParams.get("sortBy") as ToolsSortByValues;
  const sortDirectionFromUrl = searchParams.get(
    "sortDirection",
  ) as ToolsSortDirectionValues;

  // State
  const [originFilter, setOriginFilter] = useState(
    originFromUrl || DEFAULT_FILTER_ALL,
  );
  const [observedByFilter, setObservedByFilter] = useState(
    observedByFromUrl || DEFAULT_FILTER_ALL,
  );
  const [clientFilter, setClientFilter] = useState(
    clientFromUrl || DEFAULT_FILTER_ALL,
  );
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || DEFAULT_SORT_BY,
      desc: sortDirectionFromUrl !== "asc",
    },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<ToolWithAssignmentsData[]>(
    [],
  );
  const [updatingRows, setUpdatingRows] = useState<
    Set<{ id: string; field: string }>
  >(new Set());

  // The user/client attribution filters only make sense for observed tools —
  // MCP-server-sourced tools never appear in LLM proxy requests under their
  // catalog names, so they carry no observations. Both filters are shown and
  // applied only while the source filter is "Observed tools".
  const observationFiltersActive = originFilter === "llm-proxy";

  // The observed-by client filter only accepts known client families; anything
  // else in the URL is treated as unset.
  const parsedClientFilter = ClientFilterSchema.safeParse(clientFilter);

  // Fetch tools with assignments with server-side pagination, filtering, and sorting
  // Only use initialData for first page with default sorting and no filters
  const useInitialData =
    pageIndex === 0 &&
    pageSize === DEFAULT_TABLE_LIMIT &&
    !searchFromUrl &&
    originFilter === DEFAULT_FILTER_ALL &&
    observedByFilter === DEFAULT_FILTER_ALL &&
    clientFilter === DEFAULT_FILTER_ALL &&
    (sorting[0]?.id === DEFAULT_SORT_BY || !sorting[0]?.id) &&
    sorting[0]?.desc !== false;

  /** Shared by the page query and the "all matching" walk behind it. */
  const listSorting = {
    sortBy: (sorting[0]?.id as ToolsSortByValues) || "createdAt",
    sortDirection: sorting[0]?.desc ? ("desc" as const) : ("asc" as const),
  };
  const listFilters = {
    search: searchFromUrl || undefined,
    origin: originFilter !== "all" ? originFilter : undefined,
    observedByUserId:
      observationFiltersActive && observedByFilter !== DEFAULT_FILTER_ALL
        ? observedByFilter
        : undefined,
    observedByClient:
      observationFiltersActive && parsedClientFilter.success
        ? parsedClientFilter.data
        : undefined,
    excludeArchestraTools: true,
    includeKnowledgeSourcesTool: true,
  };

  const { data: toolsData, isLoading } = useToolsWithAssignments({
    initialData: useInitialData ? initialData?.toolsWithAssignments : undefined,
    pagination: {
      limit: pageSize,
      offset: pageIndex * pageSize,
    },
    sorting: listSorting,
    filters: listFilters,
  });

  const { data: toolObservers } = useToolObservers();

  const tools = toolsData?.data ?? [];

  /**
   * The ticked rows and the tool objects the bulk bar acts on are separate
   * state, so dropping a selection has to drop both — clearing only the row
   * ids leaves the bar reporting a count of tools nothing is ticking.
   */
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectedTools([]);
    setEscalatedFor(null);
  }, []);

  /**
   * An escalation is remembered as the filters it was made under, so changing
   * one drops it rather than silently re-pointing "all 203 tools" at a
   * different 203.
   */
  const filterSignature = JSON.stringify({ listFilters, listSorting });
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;

  const { data: allMatchingTools, isFetching: isFetchingAllMatching } =
    useAllMatchingTools({
      filters: listFilters,
      sorting: listSorting,
      enabled: allMatchingSelected,
    });

  const bulkTools =
    allMatchingSelected && allMatchingTools ? allMatchingTools : selectedTools;

  // Helper to update URL params
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      clearSelection();
      setPagination(newPagination);
    },
    [setPagination, clearSelection],
  );

  const handleRowSelectionChange = useCallback(
    (newRowSelection: RowSelectionState) => {
      setRowSelection(newRowSelection);

      const newSelectedTools = Object.keys(newRowSelection)
        .map((rowId) => tools.find((tool) => tool.id === rowId))
        .filter((tool): tool is ToolWithAssignmentsData => Boolean(tool));

      setSelectedTools(newSelectedTools);
    },
    [tools],
  );

  const handleSearchChange = useCallback(() => {
    clearSelection();
  }, [clearSelection]);

  const handleOriginFilterChange = useCallback(
    (value: string) => {
      setOriginFilter(value);
      // Leaving "Observed tools" hides the attribution filters, so clear them
      // too — a hidden filter must not keep narrowing the list.
      const leavingObservedTools = value !== "llm-proxy";
      if (leavingObservedTools) {
        setObservedByFilter(DEFAULT_FILTER_ALL);
        setClientFilter(DEFAULT_FILTER_ALL);
      }
      updateQueryParams({
        origin: value === "all" ? null : value,
        ...(leavingObservedTools && { observedBy: null, client: null }),
        page: "1", // Reset to first page
      });
      clearSelection();
    },
    [updateQueryParams, clearSelection],
  );

  const handleObservedByFilterChange = useCallback(
    (value: string) => {
      setObservedByFilter(value);
      updateQueryParams({
        observedBy: value === DEFAULT_FILTER_ALL ? null : value,
        page: "1", // Reset to first page
      });
      clearSelection();
    },
    [updateQueryParams, clearSelection],
  );

  const handleClientFilterChange = useCallback(
    (value: string) => {
      setClientFilter(value);
      updateQueryParams({
        client: value === DEFAULT_FILTER_ALL ? null : value,
        page: "1", // Reset to first page
      });
      clearSelection();
    },
    [updateQueryParams, clearSelection],
  );

  const handleSortingChange = useCallback(
    (newSorting: SortingState) => {
      setSorting(newSorting);
      if (newSorting.length > 0) {
        updateQueryParams({
          page: "1",
          sortBy: newSorting[0].id,
          sortDirection: newSorting[0].desc ? "desc" : "asc",
        });
      } else {
        updateQueryParams({
          page: "1",
          sortBy: null,
          sortDirection: null,
        });
      }

      // Preserve selection by tool IDs after sorting
      const currentSelection = rowSelection;
      if (Object.keys(currentSelection).length > 0) {
        const newSelection: RowSelectionState = {};
        tools.forEach((tool) => {
          if (currentSelection[tool.id]) {
            newSelection[tool.id] = true;
          }
        });
        setRowSelection(newSelection);
      }
    },
    [updateQueryParams, rowSelection, tools],
  );

  const clearFilters = useCallback(() => {
    setOriginFilter(DEFAULT_FILTER_ALL);
    setObservedByFilter(DEFAULT_FILTER_ALL);
    setClientFilter(DEFAULT_FILTER_ALL);
    handleSearchChange();
    updateQueryParams({
      search: null,
      origin: null,
      observedBy: null,
      client: null,
      page: "1",
    });
  }, [handleSearchChange, updateQueryParams]);

  const isRowFieldUpdating = useCallback(
    (id: string, field: "callPolicy" | "resultPolicyAction") => {
      return Array.from(updatingRows).some(
        (row) => row.id === id && row.field === field,
      );
    },
    [updatingRows],
  );

  const handleSingleRowUpdate = useCallback(
    async (
      toolId: string,
      field: "callPolicy" | "resultPolicyAction",
      value: CallPolicyAction | ResultPolicyAction,
    ) => {
      setUpdatingRows((prev) => new Set(prev).add({ id: toolId, field }));
      try {
        if (field === "callPolicy") {
          await callPolicyMutation.mutateAsync({
            toolId,
            action: value as CallPolicyAction,
          });
        } else {
          await resultPolicyMutation.mutateAsync({
            toolId,
            action: value as ResultPolicyAction,
          });
        }
      } catch (error) {
        console.error("Update failed:", error);
      } finally {
        setUpdatingRows((prev) => {
          const next = new Set(prev);
          for (const item of next) {
            if (item.id === toolId && item.field === field) {
              next.delete(item);
              break;
            }
          }
          return next;
        });
      }
    },
    [callPolicyMutation, resultPolicyMutation],
  );

  const columns: ColumnDef<ToolWithAssignmentsData>[] = useMemo(
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
        cell: ({ row }) => {
          // Only trim prefix for MCP tools (which have catalogId set and were slugified with server name)
          // LLM proxy discovered tools (no catalogId) should show the full name as-is.
          // It's needed to show the full name in the table to distinguish them from catalog tools. (After prefix-stripping they might look the same)
          const displayName = row.original.catalogId
            ? parseFullToolName(row.original.name).toolName || row.original.name
            : row.original.name;
          // A delegation tool is named after its target agent, so the personal
          // agents seeded one per member all mint an `agent__my_assistant`.
          // The owner is the only thing separating those rows.
          const source = getToolSource(row.original, internalMcpCatalogItems);
          const owner = source.kind === "agent" ? source.ownerEmail : null;
          return (
            <div className="max-w-[260px] md:max-w-none truncate">
              <TruncatedText
                message={displayName}
                className="break-all"
                maxLength={60}
              />
              {owner && (
                <div className="truncate text-xs text-muted-foreground">
                  {owner}
                </div>
              )}
            </div>
          );
        },
        size: 200,
      },
      {
        id: "origin",
        // Mirrors the backend's origin ordering (catalog-backed first, then
        // delegation, then observed); app launch tools are catalog-backed.
        accessorFn: (row) => {
          const kind = getToolSource(row, internalMcpCatalogItems).kind;
          if (kind === "app" || kind === "mcp") return "1-mcp";
          return kind === "agent" ? "2-agent" : "3-intercepted";
        },
        size: 180,
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Source
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const source = getToolSource(row.original, internalMcpCatalogItems);

          if (source.kind === "app") {
            return (
              <div className="min-w-0 max-w-full">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="default"
                        className="bg-sky-600 text-white inline-flex max-w-full gap-1.5 overflow-hidden align-middle"
                      >
                        <AppWindow className="h-3.5 w-3.5 shrink-0" />
                        <span className="min-w-0 truncate">
                          {source.appName || APP_TOOL_SOURCE_LABEL}
                        </span>
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{APP_TOOL_SOURCE_DESCRIPTION}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          }

          if (source.kind === "mcp") {
            const { catalogItem } = source;
            return (
              <div className="min-w-0 max-w-full">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="default"
                        className="bg-indigo-500 text-white inline-flex max-w-full gap-1.5 overflow-hidden align-middle"
                      >
                        {catalogItem ? (
                          <McpCatalogIcon
                            icon={catalogItem.icon}
                            catalogId={catalogItem.id}
                            size={14}
                          />
                        ) : (
                          <Server className="h-3.5 w-3.5 shrink-0" />
                        )}
                        <span className="min-w-0 truncate">
                          {catalogItem?.name ?? MCP_TOOL_SOURCE_LABEL}
                        </span>
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{catalogItem?.name ?? MCP_TOOL_SOURCE_LABEL}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
            );
          }

          if (source.kind === "agent") {
            return (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Badge
                      variant="secondary"
                      className="bg-violet-600 text-white gap-1.5"
                    >
                      <Bot className="h-3.5 w-3.5 shrink-0" />
                      Agent
                    </Badge>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>
                      Delegates to {source.agentName} agent
                      {source.ownerEmail ? ` (${source.ownerEmail})` : ""}
                    </p>
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
                    className="bg-amber-700 text-white gap-1.5"
                  >
                    <Network className="h-3.5 w-3.5 shrink-0" />
                    {OBSERVED_TOOL_SOURCE_LABEL}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{OBSERVED_TOOL_SOURCE_DESCRIPTION}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          );
        },
      },
      {
        id: "assignmentCount",
        header: "Assignments",
        size: 140,
        cell: ({ row }) => {
          const count = row.original.assignmentCount;
          return (
            <Badge variant="outline" className="text-xs">
              {count} {count === 1 ? "assignment" : "assignments"}
            </Badge>
          );
        },
      },
      {
        id: "callPolicy",
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Call Policy
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const policies =
            invocationPolicies?.byProfileToolId[row.original.id] || [];
          // A custom policy has non-empty conditions array
          const hasCustomPolicy = policies.some(
            (policy) => policy.conditions.length > 0,
          );

          if (hasCustomPolicy) {
            return (
              <Button
                variant="outline"
                size="sm"
                className="w-[90px] text-xs"
                onClick={() => onToolClick(row.original)}
              >
                Custom
              </Button>
            );
          }

          const isUpdating = isRowFieldUpdating(row.original.id, "callPolicy");

          const currentAction = getCallPolicyActionFromPolicies(
            row.original.id,
            invocationPolicies ?? { byProfileToolId: {} },
          );

          return (
            <WithPermissions
              permissions={{ toolPolicy: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex items-center gap-2">
                  <CallPolicyToggle
                    value={currentAction}
                    onChange={(action) =>
                      handleSingleRowUpdate(
                        row.original.id,
                        "callPolicy",
                        action,
                      )
                    }
                    disabled={isUpdating || !hasPermission}
                    size="sm"
                  />
                  {isUpdating && (
                    <LoadingSpinner className="ml-1 h-3 w-3 text-muted-foreground" />
                  )}
                </div>
              )}
            </WithPermissions>
          );
        },
      },
      {
        id: "toolResultTreatment",
        header: "Results are",
        cell: ({ row }) => {
          const policies =
            resultPolicies?.byProfileToolId[row.original.id] || [];
          // A custom policy has non-empty conditions array
          const hasCustomPolicy = policies.some(
            (policy) => policy.conditions.length > 0,
          );

          if (hasCustomPolicy) {
            return (
              <Button
                variant="outline"
                size="sm"
                className="w-[90px] text-xs"
                onClick={() => onToolClick(row.original)}
              >
                Custom
              </Button>
            );
          }

          const isUpdating = isRowFieldUpdating(
            row.original.id,
            "resultPolicyAction",
          );

          const resultAction = getResultPolicyActionFromPolicies(
            row.original.id,
            resultPolicies ?? { byProfileToolId: {} },
          );

          return (
            <WithPermissions
              permissions={{ toolPolicy: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex items-center gap-2">
                  <ResultPolicyToggle
                    size="sm"
                    value={resultAction}
                    onChange={(action) => {
                      if (action === resultAction) return;
                      handleSingleRowUpdate(
                        row.original.id,
                        "resultPolicyAction",
                        action,
                      );
                    }}
                    disabled={isUpdating || !hasPermission}
                  />
                  {isUpdating && (
                    <LoadingSpinner className="h-3 w-3 text-muted-foreground" />
                  )}
                </div>
              )}
            </WithPermissions>
          );
        },
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <TableRowActions
            itemName={row.original.name}
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit policies",
                permissions: { toolPolicy: ["update"] },
                onClick: () => onToolClick(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [
      invocationPolicies,
      resultPolicies,
      internalMcpCatalogItems,
      isRowFieldUpdating,
      handleSingleRowUpdate,
      onToolClick,
    ],
  );

  const visibleCatalogSources = useMemo(
    () => getVisibleCatalogSources(internalMcpCatalogItems),
    [internalMcpCatalogItems],
  );

  // One entry per app would bury the MCP servers, so apps get a single grouped
  // source — offered only where there is an app to filter to.
  const hasAppSources = useMemo(
    () => hasAppCatalogSources(internalMcpCatalogItems),
    [internalMcpCatalogItems],
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap gap-4">
        <SearchInput
          objectNamePlural="tools"
          searchFields={["name"]}
          paramName="search"
          onSearchChange={handleSearchChange}
        />

        <SearchableSelect
          value={originFilter}
          onValueChange={handleOriginFilterChange}
          placeholder="Filter by Source"
          items={[
            { value: "all", label: "All Sources" },
            {
              value: "agent",
              label: "Agent",
              content: (
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 shrink-0" />
                  <span className="truncate">Agent</span>
                </div>
              ),
              selectedContent: (
                <div className="flex items-center gap-2 min-w-0">
                  <Bot className="h-4 w-4 shrink-0" />
                  <span className="truncate">Agent</span>
                </div>
              ),
            },
            ...(hasAppSources
              ? [
                  {
                    value: APP_ORIGIN_FILTER_VALUE,
                    label: APP_TOOL_SOURCE_LABEL,
                    content: (
                      <div className="flex items-center gap-2 min-w-0">
                        <AppWindow className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          {APP_TOOL_SOURCE_LABEL}
                        </span>
                      </div>
                    ),
                    selectedContent: (
                      <div className="flex items-center gap-2 min-w-0">
                        <AppWindow className="h-4 w-4 shrink-0" />
                        <span className="truncate">
                          {APP_TOOL_SOURCE_LABEL}
                        </span>
                      </div>
                    ),
                  },
                ]
              : []),
            {
              value: "llm-proxy",
              label: OBSERVED_TOOL_SOURCE_LABEL,
              content: (
                <div className="flex items-center gap-2 min-w-0">
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="truncate">{OBSERVED_TOOL_SOURCE_LABEL}</span>
                </div>
              ),
              selectedContent: (
                <div className="flex items-center gap-2 min-w-0">
                  <Network className="h-4 w-4 shrink-0" />
                  <span className="truncate">{OBSERVED_TOOL_SOURCE_LABEL}</span>
                </div>
              ),
            },
            ...visibleCatalogSources.map((source) => ({
              value: source.id,
              label: source.name,
              content: (
                <div className="flex items-center gap-2 min-w-0">
                  <McpCatalogIcon
                    icon={source.icon}
                    catalogId={source.id}
                    size={16}
                  />
                  <span className="truncate">{source.name}</span>
                </div>
              ),
              selectedContent: (
                <div className="flex items-center gap-2 min-w-0">
                  <McpCatalogIcon
                    icon={source.icon}
                    catalogId={source.id}
                    size={16}
                  />
                  <span className="truncate">{source.name}</span>
                </div>
              ),
            })),
          ]}
          className="w-full sm:w-[200px]"
        />

        {/* Observed-tool attribution filters: narrow the list to tools seen in
            one user's LLM proxy traffic, from one client app family. Only
            shown while the source filter is "Observed tools" — MCP-sourced
            tools carry no observations — and once someone has observed tools. */}
        {observationFiltersActive && (toolObservers?.users.length ?? 0) > 0 && (
          <UserFilterSelect
            value={observedByFilter}
            onValueChange={handleObservedByFilterChange}
            users={toolObservers?.users}
          />
        )}

        {observationFiltersActive &&
          (toolObservers?.clients.length ?? 0) > 0 && (
            <ClientFilterSelect
              value={clientFilter}
              onValueChange={handleClientFilterChange}
              clients={toolObservers?.clients}
            />
          )}
      </div>

      <ToolPolicyBulkActionsBar
        selectedToolIds={bulkTools.map((tool) => tool.id)}
        onClear={clearSelection}
        busy={isFetchingAllMatching}
        selectAllMatching={{
          total: toolsData?.pagination?.total ?? 0,
          pageFullySelected:
            tools.length > 0 && selectedTools.length === tools.length,
          active: allMatchingSelected,
          onSelectAll: () => setEscalatedFor(filterSignature),
          matchDescription: searchFromUrl
            ? "match this search query"
            : "match the current filters",
        }}
      />

      <DataTable
        columns={columns}
        data={tools}
        sorting={sorting}
        onSortingChange={handleSortingChange}
        manualSorting
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: toolsData?.pagination?.total ?? 0,
        }}
        onPaginationChange={handlePaginationChange}
        // The bulk bar above already names the count.
        hideSelectedCount
        rowSelection={rowSelection}
        onRowSelectionChange={handleRowSelectionChange}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        hasActiveFilters={
          !!searchFromUrl ||
          originFilter !== DEFAULT_FILTER_ALL ||
          observedByFilter !== DEFAULT_FILTER_ALL ||
          clientFilter !== DEFAULT_FILTER_ALL
        }
        emptyMessage="No tools have been assigned yet."
        filteredEmptyMessage="No tools match your filters. Try adjusting your search."
        onClearFilters={clearFilters}
      />
    </div>
  );
}
