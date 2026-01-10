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
  Search,
  Sparkles,
  Unplug,
  Wand2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner } from "@/components/loading";
import {
  DYNAMIC_CREDENTIAL_VALUE,
  TokenSelect,
} from "@/components/token-select";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
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
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import {
  useAllProfileTools,
  useAutoConfigurePolicies,
  useBulkUpdateProfileTools,
  useProfileToolPatchMutation,
  useUnassignTool,
} from "@/lib/agent-tools.query";
import { useInternalMcpCatalog } from "@/lib/internal-mcp-catalog.query";
import { useMcpServers } from "@/lib/mcp-server.query";
import {
  useToolInvocationPolicies,
  useToolResultPolicies,
} from "@/lib/policy.query";
import { isMcpTool } from "@/lib/tool.utils";
import {
  DEFAULT_FILTER_ALL,
  DEFAULT_SORT_BY,
  DEFAULT_TOOLS_PAGE_SIZE,
} from "@/lib/utils";
import type { ToolsInitialData } from "../page";

type GetAllProfileToolsQueryParams = NonNullable<
  archestraApiTypes.GetAllAgentToolsData["query"]
>;
type ProfileToolsSortByValues = NonNullable<
  GetAllProfileToolsQueryParams["sortBy"]
> | null;
type ProfileToolsSortDirectionValues = NonNullable<
  GetAllProfileToolsQueryParams["sortDirection"]
> | null;

type ProfileToolData =
  archestraApiTypes.GetAllAgentToolsResponses["200"]["data"][number];
type ToolResultTreatment = ProfileToolData["toolResultTreatment"];

interface AssignedToolsTableProps {
  onToolClick: (tool: ProfileToolData) => void;
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
  const agentToolPatchMutation = useProfileToolPatchMutation();
  const bulkUpdateMutation = useBulkUpdateProfileTools();
  const autoConfigureMutation = useAutoConfigurePolicies();
  const unassignToolMutation = useUnassignTool();
  const { data: invocationPolicies } = useToolInvocationPolicies(
    initialData?.toolInvocationPolicies,
  );
  const { data: resultPolicies } = useToolResultPolicies(
    initialData?.toolResultPolicies,
  );
  const { data: internalMcpCatalogItems } = useInternalMcpCatalog({
    initialData: initialData?.internalMcpCatalog,
  });
  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });
  const { data: mcpServers } = useMcpServers({
    initialData: initialData?.mcpServers,
  });

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
  const sortByFromUrl = searchParams.get("sortBy") as ProfileToolsSortByValues;
  const sortDirectionFromUrl = searchParams.get(
    "sortDirection",
  ) as ProfileToolsSortDirectionValues;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TOOLS_PAGE_SIZE);

  // State
  const [searchQuery, setSearchQuery] = useState(searchFromUrl || "");
  const [agentFilter, setProfileFilter] = useState(
    agentIdFromUrl || DEFAULT_FILTER_ALL,
  );
  const [originFilter, setOriginFilter] = useState(
    originFromUrl || DEFAULT_FILTER_ALL,
  );
  const [credentialFilter, setCredentialFilter] = useState(
    credentialFromUrl || DEFAULT_FILTER_ALL,
  );
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || DEFAULT_SORT_BY,
      desc: sortDirectionFromUrl !== "asc",
    },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectedTools, setSelectedTools] = useState<ProfileToolData[]>([]);
  const [updatingRows, setUpdatingRows] = useState<
    Set<{ id: string; field: string }>
  >(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

  // Fetch agent tools with server-side pagination, filtering, and sorting
  // Only use initialData for first page with default sorting and no filters
  const useInitialData =
    pageIndex === 0 &&
    pageSize === DEFAULT_TOOLS_PAGE_SIZE &&
    !searchQuery &&
    agentFilter === DEFAULT_FILTER_ALL &&
    originFilter === DEFAULT_FILTER_ALL &&
    credentialFilter === DEFAULT_FILTER_ALL &&
    (sorting[0]?.id === DEFAULT_SORT_BY || !sorting[0]?.id) &&
    sorting[0]?.desc !== false;

  const {
    data: agentToolsData,
    isLoading,
    refetch,
  } = useAllProfileTools({
    initialData: useInitialData ? initialData?.agentTools : undefined,
    pagination: {
      limit: pageSize,
      offset: pageIndex * pageSize,
    },
    sorting: {
      sortBy: (sorting[0]?.id as ProfileToolsSortByValues) || "createdAt",
      sortDirection: sorting[0]?.desc ? "desc" : "asc",
    },
    filters: {
      search: searchQuery || undefined,
      agentId: agentFilter !== "all" ? agentFilter : undefined,
      origin: originFilter !== "all" ? originFilter : undefined,
      mcpServerOwnerId:
        credentialFilter !== "all" ? credentialFilter : undefined,
    },
  });

  const agentTools = agentToolsData?.data ?? [];

  // Poll for updates when tools are auto-configuring
  const pollingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Always clear existing interval first to prevent race conditions
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }

    // Check if any tools are currently auto-configuring
    const hasAutoConfiguringTools = agentTools.some(
      (tool) => tool.policiesAutoConfiguringStartedAt,
    );

    // Only create new interval if needed
    if (hasAutoConfiguringTools) {
      pollingIntervalRef.current = setInterval(() => {
        refetch();
      }, 2000);
    }

    // Cleanup on unmount
    return () => {
      if (pollingIntervalRef.current) {
        clearInterval(pollingIntervalRef.current);
        pollingIntervalRef.current = null;
      }
    };
  }, [agentTools, refetch]);

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

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
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
    async (
      field: "allowUsageWhenUntrustedDataIsPresent" | "toolResultTreatment",
      value: boolean | "trusted" | "sanitize_with_dual_llm" | "untrusted",
    ) => {
      setIsBulkUpdating(true);

      // Filter out tools with custom policies
      const toolIds = selectedTools
        .filter((tool) => {
          if (field === "allowUsageWhenUntrustedDataIsPresent") {
            const hasCustomInvocationPolicy =
              invocationPolicies?.byProfileToolId[tool.id]?.length > 0;
            return !hasCustomInvocationPolicy;
          }

          if (field === "toolResultTreatment") {
            const hasCustomResultPolicy =
              resultPolicies?.byProfileToolId[tool.id]?.length > 0;
            return !hasCustomResultPolicy;
          }

          return true;
        })
        .map((tool) => tool.id);

      if (toolIds.length === 0) {
        setIsBulkUpdating(false);
        return;
      }

      try {
        await bulkUpdateMutation.mutateAsync({
          ids: toolIds,
          field,
          value,
          // Clear auto-configured timestamp when manually bulk updating policies
          clearAutoConfigured: true,
        });
      } catch (error) {
        console.error("Bulk update failed:", error);
      } finally {
        setIsBulkUpdating(false);
      }
    },
    [selectedTools, bulkUpdateMutation, invocationPolicies, resultPolicies],
  );

  const handleAutoConfigurePolicies = useCallback(async () => {
    const agentToolIds = selectedTools.map((tool) => tool.id);

    if (agentToolIds.length === 0) {
      return;
    }

    try {
      const result = await autoConfigureMutation.mutateAsync(agentToolIds);

      const successCount = result.results.filter(
        (r: { success: boolean }) => r.success,
      ).length;
      const failureCount = result.results.filter(
        (r: { success: boolean }) => !r.success,
      ).length;

      if (failureCount === 0) {
        toast.success(`Policies configured for ${successCount} tool(s)`);
      } else {
        toast.warning(
          `Configured ${successCount} tool(s), failed ${failureCount}`,
        );
      }
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
    (
      id: string,
      field: "allowUsageWhenUntrustedDataIsPresent" | "toolResultTreatment",
    ) => {
      return Array.from(updatingRows).some(
        (row) => row.id === id && row.field === field,
      );
    },
    [updatingRows],
  );

  const handleSingleRowUpdate = useCallback(
    async (id: string, field: string, updates: Partial<ProfileToolData>) => {
      setUpdatingRows((prev) => new Set(prev).add({ id, field }));
      try {
        // Clear auto-configured timestamp when manually updating policies
        const shouldClearAutoConfig =
          field === "allowUsageWhenUntrustedDataIsPresent" ||
          field === "toolResultTreatment";

        await agentToolPatchMutation.mutateAsync({
          id,
          ...updates,
          ...(shouldClearAutoConfig && { policiesAutoConfiguredAt: null }),
        });
      } catch (error) {
        console.error("Update failed:", error);
      } finally {
        setUpdatingRows((prev) => {
          const next = new Set(prev);
          for (const item of next) {
            if (item.id === id && item.field === field) {
              next.delete(item);
              break;
            }
          }
          return next;
        });
      }
    },
    [agentToolPatchMutation],
  );

  const columns: ColumnDef<ProfileToolData>[] = useMemo(
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
            maxLength={60}
          />
        ),
        size: 200,
        minSize: 200,
        maxSize: 200,
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
            Profile
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        ),
        cell: ({ row }) => {
          const agentName = row.original.agent?.name || "-";

          const TruncatedProfileName = (
            <TruncatedText message={agentName} maxLength={30} />
          );

          if (!isMcpTool(row.original.tool)) {
            return TruncatedProfileName;
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
              {TruncatedProfileName}
              <PermissionButton
                permissions={{ tool: ["delete"] }}
                variant="ghost"
                size="icon-sm"
                tooltip="Unassign from profile"
                onClick={(e) => {
                  e.stopPropagation();
                  handleUnassign(e);
                }}
                disabled={unassignToolMutation.isPending}
              >
                <Unplug className="h-4 w-4" />
              </PermissionButton>
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

          // Show dynamic value if useDynamicTeamCredential is true
          const currentValue = row.original.useDynamicTeamCredential
            ? DYNAMIC_CREDENTIAL_VALUE
            : isLocalServer
              ? row.original.executionSourceMcpServerId
              : row.original.credentialSourceMcpServerId;

          return (
            <TokenSelect
              value={currentValue}
              onValueChange={(value) => {
                if (value === null) return;

                const isDynamic = value === DYNAMIC_CREDENTIAL_VALUE;
                agentToolPatchMutation.mutate({
                  id: row.original.id,
                  ...(isLocalServer
                    ? { executionSourceMcpServerId: isDynamic ? null : value }
                    : {
                        credentialSourceMcpServerId: isDynamic ? null : value,
                      }),
                  useDynamicTeamCredential: isDynamic,
                });
              }}
              catalogId={row.original.tool.catalogId ?? ""}
              className="h-8 w-[200px] text-xs"
              shouldSetDefaultValue={false}
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
            invocationPolicies?.byProfileToolId[row.original.id]?.length > 0;

          if (hasCustomPolicy) {
            return (
              <span className="text-xs font-medium text-primary">Custom</span>
            );
          }

          const isUpdating = isRowFieldUpdating(
            row.original.id,
            "allowUsageWhenUntrustedDataIsPresent",
          );

          const isAutoConfigured = !!row.original.policiesAutoConfiguredAt;
          const isAutoConfiguring =
            !!row.original.policiesAutoConfiguringStartedAt;

          return (
            <div className="flex items-center gap-2">
              <Switch
                checked={row.original.allowUsageWhenUntrustedDataIsPresent}
                disabled={isUpdating}
                onCheckedChange={(checked) => {
                  handleSingleRowUpdate(
                    row.original.id,
                    "allowUsageWhenUntrustedDataIsPresent",
                    {
                      allowUsageWhenUntrustedDataIsPresent: checked,
                    },
                  );
                }}
                onClick={(e) => e.stopPropagation()}
                aria-label={`Allow ${row.original.tool.name} in untrusted context`}
              />
              <span className="text-xs text-muted-foreground">
                {row.original.allowUsageWhenUntrustedDataIsPresent
                  ? "Allowed"
                  : "Blocked"}
              </span>
              {isAutoConfiguring ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Loader2 className="h-3 w-3 text-purple-500 animate-spin" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Policy Configuration Subagent is analyzing...</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : isAutoConfigured ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Sparkles className="h-3 w-3 text-purple-500" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-md">
                      <p className="font-semibold mb-1">
                        Configured by Policy Configuration Subagent
                      </p>
                      {row.original.policiesAutoConfiguredReasoning && (
                        <p className="text-xs text-muted-foreground">
                          {row.original.policiesAutoConfiguredReasoning}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {isUpdating && (
                <LoadingSpinner className="ml-1 h-3 w-3 text-muted-foreground" />
              )}
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
            resultPolicies?.byProfileToolId[row.original.id]?.length > 0;

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

          const isUpdating = isRowFieldUpdating(
            row.original.id,
            "toolResultTreatment",
          );

          const isAutoConfigured = !!row.original.policiesAutoConfiguredAt;
          const isAutoConfiguring =
            !!row.original.policiesAutoConfiguringStartedAt;

          return (
            <div className="flex items-center gap-2">
              <Select
                value={row.original.toolResultTreatment}
                disabled={isUpdating}
                onValueChange={(value: ToolResultTreatment) => {
                  handleSingleRowUpdate(
                    row.original.id,
                    "toolResultTreatment",
                    {
                      toolResultTreatment: value,
                    },
                  );
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
              {isAutoConfiguring ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Loader2 className="h-3 w-3 text-purple-500 animate-spin" />
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>Policy Configuration Subagent is analyzing...</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : isAutoConfigured ? (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Sparkles className="h-3 w-3 text-purple-500" />
                    </TooltipTrigger>
                    <TooltipContent className="max-w-md">
                      <p className="font-semibold mb-1">
                        Configured by Policy Configuration Subagent
                      </p>
                      {row.original.policiesAutoConfiguredReasoning && (
                        <p className="text-xs text-muted-foreground">
                          {row.original.policiesAutoConfiguredReasoning}
                        </p>
                      )}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              ) : null}
              {isUpdating && (
                <LoadingSpinner className="h-3 w-3 text-muted-foreground" />
              )}
            </div>
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
      internalMcpCatalogItems,
      isRowFieldUpdating,
      handleSingleRowUpdate,
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

  // Get unique credentials (MCP servers) deduplicated by owner email
  const uniqueCredentials = useMemo(() => {
    if (!mcpServers) return [];

    // Create a map of ownerEmail -> mcpServer to deduplicate
    const ownerToMcpServerMap = new Map<string, (typeof mcpServers)[0]>();

    for (const server of mcpServers) {
      const key = server.ownerEmail || `__no_owner_${server.id}__`;
      if (!ownerToMcpServerMap.has(key)) {
        ownerToMcpServerMap.set(key, server);
      }
    }

    return Array.from(ownerToMcpServerMap.values());
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

        <SearchableSelect
          value={agentFilter}
          onValueChange={handleProfileFilterChange}
          placeholder="Filter by Profile"
          items={[
            { value: "all", label: "All Profiles" },
            ...(agents?.map((agent) => ({
              value: agent.id,
              label: agent.name,
            })) || []),
          ]}
          className="w-[200px]"
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
            })),
          ]}
          className="w-[200px]"
        />

        <SearchableSelect
          value={credentialFilter}
          onValueChange={handleCredentialFilterChange}
          placeholder="Filter by Credential"
          items={[
            { value: "all", label: "All Credentials" },
            ...uniqueCredentials.map((credential) => ({
              value: credential.ownerId || "",
              label: credential.ownerEmail || credential.name,
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
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              In untrusted context:
            </span>
            <ButtonGroup>
              <PermissionButton
                permissions={{ tool: ["update"] }}
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction("allowUsageWhenUntrustedDataIsPresent", true)
                }
                disabled={!hasSelection || isBulkUpdating}
              >
                Allow
              </PermissionButton>
              <PermissionButton
                permissions={{ tool: ["update"] }}
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction(
                    "allowUsageWhenUntrustedDataIsPresent",
                    false,
                  )
                }
                disabled={!hasSelection || isBulkUpdating}
              >
                Block
              </PermissionButton>
            </ButtonGroup>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Results are:</span>
            <ButtonGroup>
              <PermissionButton
                permissions={{ tool: ["update"] }}
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction("toolResultTreatment", "trusted")
                }
                disabled={!hasSelection || isBulkUpdating}
              >
                Trusted
              </PermissionButton>
              <PermissionButton
                permissions={{ tool: ["update"] }}
                size="sm"
                variant="outline"
                onClick={() =>
                  handleBulkAction("toolResultTreatment", "untrusted")
                }
                disabled={!hasSelection || isBulkUpdating}
              >
                Untrusted
              </PermissionButton>
              <Tooltip>
                <TooltipTrigger asChild>
                  <PermissionButton
                    size="sm"
                    variant="outline"
                    permissions={{ tool: ["update"] }}
                    onClick={() =>
                      handleBulkAction(
                        "toolResultTreatment",
                        "sanitize_with_dual_llm",
                      )
                    }
                    disabled={!hasSelection || isBulkUpdating}
                  >
                    Dual LLM
                  </PermissionButton>
                </TooltipTrigger>
                <TooltipContent>
                  <p>Sanitize with Dual LLM</p>
                </TooltipContent>
              </Tooltip>
            </ButtonGroup>
          </div>
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
              <p>Automatically configure security policies using AI analysis</p>
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
      ) : agentTools.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <Search className="mb-4 h-12 w-12 text-muted-foreground/50" />
          <h3 className="mb-2 text-lg font-semibold">No tools found</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            {searchQuery ||
            agentFilter !== DEFAULT_FILTER_ALL ||
            originFilter !== DEFAULT_FILTER_ALL ||
            credentialFilter !== DEFAULT_FILTER_ALL
              ? "No tools match your filters. Try adjusting your search or filters."
              : "No tools have been assigned yet."}
          </p>
          {(searchQuery ||
            agentFilter !== DEFAULT_FILTER_ALL ||
            originFilter !== DEFAULT_FILTER_ALL ||
            credentialFilter !== DEFAULT_FILTER_ALL) && (
            <Button
              variant="outline"
              onClick={() => {
                handleSearchChange("");
                handleProfileFilterChange(DEFAULT_FILTER_ALL);
                handleOriginFilterChange(DEFAULT_FILTER_ALL);
                handleCredentialFilterChange(DEFAULT_FILTER_ALL);
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
            total: agentToolsData?.pagination?.total ?? 0,
          }}
          onPaginationChange={handlePaginationChange}
          rowSelection={rowSelection}
          onRowSelectionChange={handleRowSelectionChange}
        />
      )}
    </div>
  );
}
