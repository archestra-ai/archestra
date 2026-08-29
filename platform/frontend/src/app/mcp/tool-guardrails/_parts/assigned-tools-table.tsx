"use client";

import {
  type archestraApiTypes,
  ClientFilterSchema,
  parseFullToolName,
} from "@archestra/shared";
import type {
  ColumnDef,
  OnChangeFn,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  AppWindow,
  Bot,
  ChevronDown,
  ChevronUp,
  Network,
  Server,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { RowClickShield } from "@/components/agent-pages/row-click-shield";
import { CallPolicyToggle } from "@/components/call-policy-toggle";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { LoadingState } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { ResultPolicyToggle } from "@/components/result-policy-toggle";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SearchInput } from "@/components/search-input";
import { ToolPolicyBulkActionsBar } from "@/components/tool-policy-bulk-actions";
import { TruncatedText } from "@/components/truncated-text";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
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
type InternalMcpCatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

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

  const { data: toolsData, isFetching: isLoading } = useToolsWithAssignments({
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

  const handleRowSelectionChange = useCallback<OnChangeFn<RowSelectionState>>(
    (updater) => {
      const newRowSelection =
        typeof updater === "function" ? updater(rowSelection) : updater;
      setRowSelection(newRowSelection);

      const newSelectedTools = Object.keys(newRowSelection)
        .map((rowId) => tools.find((tool) => tool.id === rowId))
        .filter((tool): tool is ToolWithAssignmentsData => Boolean(tool));

      setSelectedTools(newSelectedTools);
    },
    [rowSelection, tools],
  );
  const { effectiveRowSelection, onRowSelectionChange } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection: handleRowSelectionChange,
      rows: tools,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
    });

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
      createSelectColumn<ToolWithAssignmentsData>({
        rowLabel: (row) => `Select ${row.name}`,
        allLabel: "Select all tools on this page",
      }),
      {
        id: "name",
        accessorFn: (row) => row.name,
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Tool
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => (
          <ToolIdentityCell
            tool={row.original}
            catalogItems={internalMcpCatalogItems}
            onOpen={() => onToolClick(row.original)}
          />
        ),
        size: 360,
      },
      {
        id: "callPolicy",
        size: 230,
        header: ({ column }) => (
          <Button
            variant="ghost"
            className="-ml-4 h-auto px-4 py-2 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Calls
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
                variant="ghost"
                size="sm"
                className="h-8 w-[200px] justify-start bg-muted px-3 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onToolClick(row.original);
                }}
              >
                Custom rules
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
                <RowClickShield className="flex items-center gap-2">
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
                    size="table"
                  />
                  {isUpdating && (
                    <LoadingState className="ml-1" variant="inline" />
                  )}
                </RowClickShield>
              )}
            </WithPermissions>
          );
        },
      },
      {
        id: "toolResultTreatment",
        size: 180,
        header: "Results",
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
                variant="ghost"
                size="sm"
                className="h-8 w-[150px] justify-start bg-muted px-3 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onToolClick(row.original);
                }}
              >
                Custom rules
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
                <RowClickShield className="flex items-center gap-2">
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
                  {isUpdating && <LoadingState variant="inline" />}
                </RowClickShield>
              )}
            </WithPermissions>
          );
        },
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
    <BulkActionsScope>
      <CollectionFilters>
        <FilterBar leading>
          <SearchInput
            isLoading={isLoading}
            objectNamePlural="tools"
            searchFields={["name"]}
            paramName="search"
            onSearchChange={handleSearchChange}
            className={filterSearchClass}
          />

          <FilterSelect
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
                    <span className="truncate">
                      {OBSERVED_TOOL_SOURCE_LABEL}
                    </span>
                  </div>
                ),
                selectedContent: (
                  <div className="flex items-center gap-2 min-w-0">
                    <Network className="h-4 w-4 shrink-0" />
                    <span className="truncate">
                      {OBSERVED_TOOL_SOURCE_LABEL}
                    </span>
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
          />

          {/* Observed-tool attribution filters: narrow the list to tools seen in
            one user's LLM proxy traffic, from one client app family. Only
            shown while the source filter is "Observed tools" — MCP-sourced
            tools carry no observations — and once someone has observed tools. */}
          {observationFiltersActive &&
            (toolObservers?.users.length ?? 0) > 0 && (
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
        </FilterBar>
      </CollectionFilters>

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
        onRowClick={onToolClick}
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
        rowSelection={effectiveRowSelection}
        onRowSelectionChange={onRowSelectionChange}
        getRowId={(row) => row.id}
        isLoading={isLoading}
        hasActiveFilters={
          !!searchFromUrl ||
          originFilter !== DEFAULT_FILTER_ALL ||
          observedByFilter !== DEFAULT_FILTER_ALL ||
          clientFilter !== DEFAULT_FILTER_ALL
        }
        emptyIcon={ShieldCheck}
        emptyMessage="No tools have been assigned yet."
        filteredEmptyMessage="No tools match your filters"
        onClearFilters={clearFilters}
        flexibleColumnIds={["name"]}
        fixedWidthColumnIds={["callPolicy", "toolResultTreatment"]}
      />
    </BulkActionsScope>
  );
}

function ToolIdentityCell({
  tool,
  catalogItems,
  onOpen,
}: {
  tool: ToolWithAssignmentsData;
  catalogItems?: InternalMcpCatalogItem[];
  onOpen: () => void;
}) {
  // Catalog-backed names include a source prefix. Observed names do not, and
  // keeping those intact prevents unrelated tools from looking identical.
  const displayName = tool.catalogId
    ? parseFullToolName(tool.name).toolName || tool.name
    : tool.name;
  const source = getToolSource(tool, catalogItems);
  const assignmentLabel =
    tool.assignmentCount === 0
      ? "Not assigned"
      : `${tool.assignmentCount} ${tool.assignmentCount === 1 ? "assignment" : "assignments"}`;

  let sourceLabel: string;
  let sourceDescription: string;
  let sourceIcon: ReactNode;

  if (source.kind === "app") {
    sourceLabel = source.appName || APP_TOOL_SOURCE_LABEL;
    sourceDescription = APP_TOOL_SOURCE_DESCRIPTION;
    sourceIcon = <AppWindow className="size-4" />;
  } else if (source.kind === "mcp") {
    sourceLabel = source.catalogItem?.name ?? MCP_TOOL_SOURCE_LABEL;
    sourceDescription = `Provided by ${sourceLabel}`;
    sourceIcon = source.catalogItem ? (
      <McpCatalogIcon
        icon={source.catalogItem.icon}
        catalogId={source.catalogItem.id}
        size={16}
      />
    ) : (
      <Server className="size-4" />
    );
  } else if (source.kind === "agent") {
    sourceLabel = `Agent · ${source.agentName}`;
    sourceDescription = source.ownerEmail
      ? `Delegates to ${source.agentName} (${source.ownerEmail})`
      : `Delegates to ${source.agentName}`;
    sourceIcon = <Bot className="size-4" />;
  } else {
    sourceLabel = OBSERVED_TOOL_SOURCE_LABEL;
    sourceDescription = OBSERVED_TOOL_SOURCE_DESCRIPTION;
    sourceIcon = <Network className="size-4" />;
  }

  return (
    <div className="flex min-w-0 items-center gap-3 py-1">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
              {sourceIcon}
            </div>
          </TooltipTrigger>
          <TooltipContent>{sourceDescription}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="min-w-0">
        <button
          type="button"
          className="block max-w-full text-left text-sm font-medium hover:underline"
          aria-label={`View policies for ${displayName}`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
        >
          <TruncatedText
            message={displayName}
            className="block truncate"
            maxLength={60}
          />
        </button>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="truncate">{sourceLabel}</span>
          <span aria-hidden className="shrink-0 text-border">
            ·
          </span>
          <span className="shrink-0">{assignmentLabel}</span>
        </div>
      </div>
    </div>
  );
}
