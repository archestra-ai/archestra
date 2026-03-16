"use client";

import { type archestraApiTypes, parseFullToolName } from "@shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Loader2, Pencil, Wand2 } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/loading";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { PermissivePolicyOverlay } from "@/components/permissive-policy-overlay";
import { WithPermissions } from "@/components/roles/with-permissions";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
import { useAutoConfigurePolicies } from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import {
  useBulkCallPolicyMutation,
  useBulkResultPolicyMutation,
  useCallPolicyMutation,
  useResultPolicyMutation,
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import {
  type CallPolicyAction,
  getCallPolicyActionFromPolicies,
  getResultPolicyActionFromPolicies,
  RESULT_POLICY_ACTION_OPTIONS,
  type ResultPolicyAction,
} from "@/lib/policy.utils";
import {
  type ToolWithAssignmentsData,
  useToolsWithAssignments,
} from "@/lib/tool.query";
import { isMcpToolByProperties } from "@/lib/tool.utils";
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import {
  DEFAULT_FILTER_ALL,
  DEFAULT_SORT_BY,
  DEFAULT_TABLE_LIMIT,
} from "@/lib/utils";
import type { ToolsInitialData } from "../page";
import { CallPolicyToggle } from "./call-policy-toggle";

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
    <div className="text-muted-foreground/50 flex flex-col items-center">
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
  const bulkCallPolicyMutation = useBulkCallPolicyMutation();
  const bulkResultPolicyMutation = useBulkResultPolicyMutation();
  const autoConfigureMutation = useAutoConfigurePolicies();
  const { data: invocationPolicies } = useToolInvocationPolicies(
    initialData?.toolInvocationPolicies,
  );
  const { data: resultPolicies } = useToolResultPolicies(
    initialData?.toolResultPolicies,
  );
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog({
    initialData: initialData?.internalMcpCatalog,
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
  const sortByFromUrl = searchParams.get("sortBy") as ToolsSortByValues;
  const sortDirectionFromUrl = searchParams.get(
    "sortDirection",
  ) as ToolsSortDirectionValues;

  // State
  const [originFilter, setOriginFilter] = useState(
    originFromUrl || DEFAULT_FILTER_ALL,
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
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [bulkCallPolicyValue, setBulkCallPolicyValue] = useState<string>("");
  const [bulkResultPolicyValue, setBulkResultPolicyValue] =
    useState<string>("");

  // Fetch tools with assignments with server-side pagination, filtering, and sorting
  // Only use initialData for first page with default sorting and no filters
  const useInitialData =
    pageIndex === 0 &&
    pageSize === DEFAULT_TABLE_LIMIT &&
    !searchFromUrl &&
    originFilter === DEFAULT_FILTER_ALL &&
    (sorting[0]?.id === DEFAULT_SORT_BY || !sorting[0]?.id) &&
    sorting[0]?.desc !== false;

  const { data: toolsData, isLoading } = useToolsWithAssignments({
    initialData: useInitialData ? initialData?.toolsWithAssignments : undefined,
    pagination: {
      limit: pageSize,
      offset: pageIndex * pageSize,
    },
    sorting: {
      sortBy: (sorting[0]?.id as ToolsSortByValues) || "createdAt",
      sortDirection: sorting[0]?.desc ? "desc" : "asc",
    },
    filters: {
      search: searchFromUrl || undefined,
      origin: originFilter !== "all" ? originFilter : undefined,
    },
  });

  const tools = toolsData?.data ?? [];

  // Helper to update URL params
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setRowSelection({});
      setSelectedTools([]);

      setPagination(newPagination);
    },
    [setPagination],
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
    setRowSelection({});
    setSelectedTools([]);
  }, []);

  const handleOriginFilterChange = useCallback(
    (value: string) => {
      setOriginFilter(value);
      updateQueryParams({
        origin: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
      setRowSelection({});
      setSelectedTools([]);
    },
    [updateQueryParams],
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

  const handleBulkAction = useCallback(
    async (
      field: "callPolicy" | "resultPolicyAction",
      value: CallPolicyAction | ResultPolicyAction,
    ) => {
      // Filter out tools with custom policies (non-empty conditions)
      const toolIds = selectedTools
        .filter((tool) => {
          const policies =
            field === "callPolicy"
              ? invocationPolicies?.byProfileToolId[tool.id] || []
              : resultPolicies?.byProfileToolId[tool.id] || [];

          // Check if tool has custom policies (non-empty conditions array)
          const hasCustomPolicy = policies.some(
            (policy) => policy.conditions.length > 0,
          );

          return !hasCustomPolicy;
        })
        .map((tool) => tool.id);

      if (toolIds.length === 0) {
        return;
      }
      try {
        setIsBulkUpdating(true);

        if (field === "callPolicy") {
          await bulkCallPolicyMutation.mutateAsync({
            toolIds,
            action: value as CallPolicyAction,
          });
        } else {
          await bulkResultPolicyMutation.mutateAsync({
            toolIds,
            action: value as ResultPolicyAction,
          });
        }
      } finally {
        setIsBulkUpdating(false);
      }
    },
    [
      selectedTools,
      bulkCallPolicyMutation,
      bulkResultPolicyMutation,
      invocationPolicies,
      resultPolicies,
    ],
  );

  const handleAutoConfigurePolicies = useCallback(async () => {
    // Get tool IDs from selected tools (policies are per tool)
    const toolIds = selectedTools.map((tool) => tool.id);

    if (toolIds.length === 0) {
      toast.error("No tools selected to configure");
      return;
    }

    try {
      const result = await autoConfigureMutation.mutateAsync(toolIds);
      if (!result) return;

      const successCount = result.results.filter(
        (r: { success: boolean }) => r.success,
      ).length;
      const failureCount = result.results.filter(
        (r: { success: boolean }) => !r.success,
      ).length;

      if (failureCount === 0) {
        toast.success(
          `Default policies configured for ${successCount} tool(s). Custom policies are preserved.`,
        );
      } else {
        toast.warning(
          `Default policies configured for ${successCount} tool(s), failed ${failureCount}. Custom policies are preserved.`,
        );
      }

      // Reset bulk action dropdowns to placeholder
      setBulkCallPolicyValue("");
      setBulkResultPolicyValue("");
    } catch (error) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : "Failed to auto-configure policies";
      toast.error(errorMessage);
    }
  }, [selectedTools, autoConfigureMutation]);

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectedTools([]);
  }, []);

  const clearFilters = useCallback(() => {
    setOriginFilter(DEFAULT_FILTER_ALL);
    handleSearchChange();
    updateQueryParams({
      search: null,
      origin: null,
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
          return (
            <div className="max-w-[260px] md:max-w-none truncate">
              <TruncatedText
                message={displayName}
                className="break-all"
                maxLength={60}
              />
            </div>
          );
        },
        size: 200,
      },
      {
        id: "origin",
        accessorFn: (row) =>
          isMcpToolByProperties(row) ? "1-mcp" : "2-intercepted",
        size: 180,
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
              <div className="min-w-0 max-w-full">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="default"
                        className="bg-indigo-500 inline-flex max-w-full gap-1.5 overflow-hidden align-middle"
                      >
                        <McpCatalogIcon
                          icon={catalogItem.icon}
                          catalogId={catalogItem.id}
                          size={14}
                        />
                        <span className="min-w-0 truncate">
                          {catalogItem.name}
                        </span>
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{catalogItem.name}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </div>
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

          const actionLabel =
            RESULT_POLICY_ACTION_OPTIONS.find(
              (opt) => opt.value === resultAction,
            )?.label ?? resultAction;

          return (
            <WithPermissions
              permissions={{ toolPolicy: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex items-center gap-2">
                  <Select
                    value={resultAction}
                    disabled={isUpdating || !hasPermission}
                    onValueChange={(value) => {
                      // Only update if value actually changed
                      if (value === resultAction) return;
                      handleSingleRowUpdate(
                        row.original.id,
                        "resultPolicyAction",
                        value as ResultPolicyAction,
                      );
                    }}
                  >
                    <SelectTrigger
                      className="h-8 w-[150px] text-xs"
                      onClick={(e) => e.stopPropagation()}
                      size="sm"
                    >
                      <SelectValue>{actionLabel}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {RESULT_POLICY_ACTION_OPTIONS.map(({ value, label }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
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

  const hasSelection = selectedTools.length > 0;

  // Get unique origins from internal MCP catalog
  const uniqueOrigins = useMemo(() => {
    const origins = new Set<{ id: string; name: string }>();
    internalMcpCatalogItems?.forEach((item) => {
      origins.add({ id: item.id, name: item.name });
    });
    return Array.from(origins);
  }, [internalMcpCatalogItems]);

  return (
    <PermissivePolicyOverlay>
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
            placeholder="Filter by Origin"
            items={[
              { value: "all", label: "All Origins" },
              { value: "llm-proxy", label: "LLM Proxy" },
              ...uniqueOrigins.map((origin) => ({
                value: origin.id,
                label: origin.name,
                content: (
                  <div className="flex items-center gap-2 min-w-0">
                    <McpCatalogIcon
                      icon={
                        internalMcpCatalogItems?.find(
                          (item) => item.id === origin.id,
                        )?.icon
                      }
                      catalogId={origin.id}
                      size={16}
                    />
                    <span className="truncate">{origin.name}</span>
                  </div>
                ),
                selectedContent: (
                  <div className="flex items-center gap-2 min-w-0">
                    <McpCatalogIcon
                      icon={
                        internalMcpCatalogItems?.find(
                          (item) => item.id === origin.id,
                        )?.icon
                      }
                      catalogId={origin.id}
                      size={16}
                    />
                    <span className="truncate">{origin.name}</span>
                  </div>
                ),
              })),
            ]}
            className="w-[200px]"
          />
        </div>

        {/* Bulk actions - Desktop */}
        <div className="hidden lg:flex flex-wrap items-center gap-4 p-4 bg-muted/50 border border-border rounded-lg">
          <div className="flex items-center gap-3">
            {hasSelection ? (
              <>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-sm font-semibold text-primary">
                    {selectedTools.length}
                  </span>
                </div>
                <span className="text-sm font-medium whitespace-nowrap">
                  {selectedTools.length === 1
                    ? "tool selected"
                    : "tools selected"}
                </span>
                {isBulkUpdating && (
                  <LoadingSpinner className="h-4 w-4 text-muted-foreground" />
                )}
              </>
            ) : (
              <span className="text-sm text-muted-foreground whitespace-nowrap">
                Select tools to apply bulk actions
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 flex-wrap ml-auto">
            <WithPermissions
              permissions={{ toolPolicy: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Call Policy:
                  </span>
                  <Select
                    disabled={!hasSelection || isBulkUpdating || !hasPermission}
                    value={bulkCallPolicyValue}
                    onValueChange={(value: CallPolicyAction) => {
                      setBulkCallPolicyValue(value);
                      handleBulkAction("callPolicy", value);
                    }}
                  >
                    <SelectTrigger className="h-8 w-[180px] text-sm" size="sm">
                      <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="allow_when_context_is_untrusted">
                        Allow always
                      </SelectItem>
                      <SelectItem value="block_when_context_is_untrusted">
                        Allow in trusted context
                      </SelectItem>
                      <SelectItem
                        value="require_approval"
                        description="Requires user confirmation before executing in chat. In autonomous agent sessions (A2A, API, MS Teams, subagents), the tool is always allowed."
                      >
                        Require approval
                      </SelectItem>
                      <SelectItem value="block_always">Block always</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </WithPermissions>
            <WithPermissions
              permissions={{ toolPolicy: ["update"] }}
              noPermissionHandle="tooltip"
            >
              {({ hasPermission }) => (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Results are:
                  </span>
                  <Select
                    disabled={!hasSelection || isBulkUpdating || !hasPermission}
                    value={bulkResultPolicyValue}
                    onValueChange={(value: ResultPolicyAction) => {
                      setBulkResultPolicyValue(value);
                      handleBulkAction("resultPolicyAction", value);
                    }}
                  >
                    <SelectTrigger className="h-8 w-[160px] text-sm" size="sm">
                      <SelectValue placeholder="Select action" />
                    </SelectTrigger>
                    <SelectContent>
                      {RESULT_POLICY_ACTION_OPTIONS.map(({ value, label }) => (
                        <SelectItem key={value} value={value}>
                          {label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </WithPermissions>
            <div className="ml-2 h-4 w-px bg-border" />
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ agent: ["update"], toolPolicy: ["update"] }}
                  size="sm"
                  variant="outline"
                  onClick={handleAutoConfigurePolicies}
                  disabled={
                    !hasSelection ||
                    isBulkUpdating ||
                    autoConfigureMutation.isPending
                  }
                >
                  {autoConfigureMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Configuring...
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-4 w-4" />
                      Configure with Subagent
                    </>
                  )}
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Automatically configure default policies using AI analysis
                </p>
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              onClick={clearSelection}
              disabled={!hasSelection || isBulkUpdating}
            >
              Clear selection
            </Button>
          </div>
        </div>

        {/* Bulk actions - Mobile */}
        <div className="flex flex-col gap-3 p-3 bg-muted/50 border border-border rounded-lg lg:hidden">
          {/* Title / selection info */}
          <div className="flex items-center gap-2">
            {hasSelection ? (
              <>
                <div className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10">
                  <span className="text-xs font-semibold text-primary">
                    {selectedTools.length}
                  </span>
                </div>
                <span className="text-sm font-medium">
                  {selectedTools.length === 1
                    ? "tool selected"
                    : "tools selected"}
                </span>
                {isBulkUpdating && (
                  <LoadingSpinner className="h-3.5 w-3.5 text-muted-foreground" />
                )}
              </>
            ) : (
              <span className="text-xs text-muted-foreground">
                Select tools to apply bulk actions
              </span>
            )}
          </div>

          {/* Call Policy */}
          <WithPermissions
            permissions={{ toolPolicy: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Call Policy
                </span>
                <Select
                  disabled={!hasSelection || isBulkUpdating || !hasPermission}
                  value={bulkCallPolicyValue}
                  onValueChange={(value: CallPolicyAction) => {
                    setBulkCallPolicyValue(value);
                    handleBulkAction("callPolicy", value);
                  }}
                >
                  <SelectTrigger className="h-9 w-full text-sm" size="sm">
                    <SelectValue placeholder="Select action" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow_when_context_is_untrusted">
                      Allow always
                    </SelectItem>
                    <SelectItem value="block_when_context_is_untrusted">
                      Allow in trusted context
                    </SelectItem>
                    <SelectItem value="block_always">Block always</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </WithPermissions>

          {/* Results are */}
          <WithPermissions
            permissions={{ toolPolicy: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">
                  Results are
                </span>
                <Select
                  disabled={!hasSelection || isBulkUpdating || !hasPermission}
                  value={bulkResultPolicyValue}
                  onValueChange={(value: ResultPolicyAction) => {
                    setBulkResultPolicyValue(value);
                    handleBulkAction("resultPolicyAction", value);
                  }}
                >
                  <SelectTrigger className="h-9 w-full text-sm" size="sm">
                    <SelectValue placeholder="Select action" />
                  </SelectTrigger>
                  <SelectContent>
                    {RESULT_POLICY_ACTION_OPTIONS.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </WithPermissions>

          {/* Action buttons */}
          <div className="flex flex-col gap-2 pt-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <PermissionButton
                  permissions={{ agent: ["update"], toolPolicy: ["update"] }}
                  size="sm"
                  variant="outline"
                  className="w-full justify-center"
                  onClick={handleAutoConfigurePolicies}
                  disabled={
                    !hasSelection ||
                    isBulkUpdating ||
                    autoConfigureMutation.isPending
                  }
                >
                  {autoConfigureMutation.isPending ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Configuring...
                    </>
                  ) : (
                    <>
                      <Wand2 className="h-4 w-4" />
                      Configure with Subagent
                    </>
                  )}
                </PermissionButton>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Automatically configure default policies using AI analysis
                </p>
              </TooltipContent>
            </Tooltip>
            <Button
              size="sm"
              variant="ghost"
              className="w-full justify-center"
              onClick={clearSelection}
              disabled={!hasSelection || isBulkUpdating}
            >
              Clear selection
            </Button>
          </div>
        </div>

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
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
          getRowId={(row) => row.id}
          isLoading={isLoading}
          hasActiveFilters={
            !!searchFromUrl || originFilter !== DEFAULT_FILTER_ALL
          }
          emptyMessage="No tools have been assigned yet."
          filteredEmptyMessage="No tools match your filters. Try adjusting your search."
          onClearFilters={clearFilters}
        />
      </div>
    </PermissivePolicyOverlay>
  );
}
