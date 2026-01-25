"use client";

import type { archestraApiTypes } from "@shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Search,
  Wand2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner } from "@/components/loading";
import { PermissivePolicyOverlay } from "@/components/permissive-policy-overlay";
import { WithPermissions } from "@/components/roles/with-permissions";
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
import { useInternalMcpCatalogSuspense } from "@/lib/internal-mcp-catalog.query";
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
import {
  DEFAULT_FILTER_ALL,
  DEFAULT_SORT_BY,
  DEFAULT_TOOLS_PAGE_SIZE,
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
  const { data: internalMcpCatalogItems } = useInternalMcpCatalogSuspense({
    initialData: initialData?.internalMcpCatalog,
  });

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const searchFromUrl = searchParams.get("search");
  const originFromUrl = searchParams.get("origin");
  const sortByFromUrl = searchParams.get("sortBy") as ToolsSortByValues;
  const sortDirectionFromUrl = searchParams.get(
    "sortDirection",
  ) as ToolsSortDirectionValues;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TOOLS_PAGE_SIZE);

  // State
  const [searchQuery, setSearchQuery] = useState(searchFromUrl || "");
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
    pageSize === DEFAULT_TOOLS_PAGE_SIZE &&
    !searchQuery &&
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
      search: searchQuery || undefined,
      origin: originFilter !== "all" ? originFilter : undefined,
    },
  });

  const tools = toolsData?.data ?? [];

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
        .map((index) => tools[Number(index)])
        .filter(Boolean);

      setSelectedTools(newSelectedTools);
    },
    [tools],
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
      setIsBulkUpdating(true);

      if (field === "callPolicy") {
        bulkCallPolicyMutation.mutate({
          toolIds,
          action: value as CallPolicyAction,
        });
      } else {
        bulkResultPolicyMutation.mutate({
          toolIds,
          action: value as ResultPolicyAction,
        });
      }
      setIsBulkUpdating(false);
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
        cell: ({ row }) => (
          <TruncatedText
            message={row.original.name}
            className="break-all"
            maxLength={60}
          />
        ),
        size: 200,
        minSize: 200,
        maxSize: 200,
      },
      {
        id: "origin",
        accessorFn: (row) =>
          isMcpToolByProperties(row) ? "1-mcp" : "2-intercepted",
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
        size: 100,
      },
      {
        id: "assignmentCount",
        header: "Assignments",
        cell: ({ row }) => {
          const count = row.original.assignmentCount;
          return (
            <Badge variant="outline" className="text-xs">
              {count} {count === 1 ? "assignment" : "assignments"}
            </Badge>
          );
        },
        size: 100,
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
            invocationPolicies,
          );

          return (
            <WithPermissions
              permissions={{ policy: ["update"] }}
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
        size: 140,
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
            resultPolicies,
          );

          const actionLabel =
            RESULT_POLICY_ACTION_OPTIONS.find(
              (opt) => opt.value === resultAction,
            )?.label ?? resultAction;

          return (
            <WithPermissions
              permissions={{ policy: ["update"] }}
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
        size: 170,
      },
      {
        id: "actions",
        header: "Actions",
        cell: ({ row }) => (
          <WithPermissions
            permissions={{ policy: ["update"] }}
            noPermissionHandle="tooltip"
          >
            {({ hasPermission }) => (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={!hasPermission}
                      onClick={() => onToolClick(row.original)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>Edit policies</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}
          </WithPermissions>
        ),
        size: 60,
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
          <div className="relative flex-1 min-w-[200px] max-w-md">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <DebouncedInput
              placeholder="Search tools by name..."
              initialValue={searchQuery}
              onChange={handleSearchChange}
              className="pl-9"
            />
          </div>

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
              })),
            ]}
            className="w-[200px]"
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
                {isBulkUpdating && (
                  <LoadingSpinner className="h-4 w-4 text-muted-foreground" />
                )}
              </>
            ) : (
              <span className="text-sm text-muted-foreground">
                Select tools to apply bulk actions
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <WithPermissions
              permissions={{ policy: ["update"] }}
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
                      <SelectItem value="block_always">Block always</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </WithPermissions>
            <WithPermissions
              permissions={{ policy: ["update"] }}
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
                  permissions={{ profile: ["update"], tool: ["update"] }}
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

        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <LoadingSpinner />
          </div>
        ) : tools.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
            <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {searchQuery || originFilter !== DEFAULT_FILTER_ALL
                ? "No tools match your filters. Try adjusting your search or filters."
                : "No tools have been assigned yet."}
            </p>
            {(searchQuery || originFilter !== DEFAULT_FILTER_ALL) && (
              <Button
                variant="outline"
                onClick={() => {
                  handleSearchChange("");
                  handleOriginFilterChange(DEFAULT_FILTER_ALL);
                }}
              >
                Clear all filters
              </Button>
            )}
          </div>
        ) : (
          <DataTable
            columns={columns}
            data={tools}
            sorting={sorting}
            onSortingChange={handleSortingChange}
            manualSorting={true}
            manualPagination={true}
            pagination={{
              pageIndex,
              pageSize,
              total: toolsData?.pagination?.total ?? 0,
            }}
            onPaginationChange={handlePaginationChange}
            rowSelection={rowSelection}
            onRowSelectionChange={handleRowSelectionChange}
          />
        )}
      </div>
    </PermissivePolicyOverlay>
  );
}
