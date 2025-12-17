"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Savings } from "@/components/savings";
import { TruncatedText } from "@/components/truncated-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useProfiles } from "@/lib/agent.query";
import {
  useInteractions,
  useUniqueExternalAgentIds,
  useUniqueUserIds,
} from "@/lib/interaction.query";

import { DynamicInteraction } from "@/lib/interaction.utils";

import { DEFAULT_TABLE_LIMIT, formatDate } from "@/lib/utils";
import { ErrorBoundary } from "../../_parts/error-boundary";

type InteractionData =
  archestraApiTypes.GetInteractionsResponses["200"]["data"][number];

type ToolBadgeProps = {
  toolName: string;
  type: "requested" | "used" | "blocked";
};

function ToolBadge({ toolName, type }: ToolBadgeProps) {
  const getVariantAndClasses = () => {
    switch (type) {
      case "requested":
        return {
          variant: "outline" as const,
          className: "border-amber-500 text-amber-600 dark:text-amber-400",
          prefix: "?",
        };
      case "used":
        return {
          variant: "default" as const,
          className: "",
          prefix: "✓",
        };
      case "blocked":
        return {
          variant: "destructive" as const,
          className: "",
          prefix: "✗",
        };
    }
  };

  const { variant, className, prefix } = getVariantAndClasses();
  const displayText = `${prefix} ${toolName}`;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge
            variant={variant}
            className={`inline-block max-w-[150px] overflow-hidden text-ellipsis whitespace-nowrap text-xs cursor-default ${className}`}
          >
            {displayText}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          <p>{toolName}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

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

export default function LlmProxyLogsPage({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  return (
    <div>
      <ErrorBoundary>
        <LogsTable initialData={initialData} />
      </ErrorBoundary>
    </div>
  );
}

function LogsTable({
  initialData,
}: {
  initialData?: {
    interactions: archestraApiTypes.GetInteractionsResponses["200"];
    agents: archestraApiTypes.GetAllAgentsResponses["200"];
  };
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const pathname = usePathname();

  // Get URL params
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const profileIdFromUrl = searchParams.get("profileId");
  const externalAgentIdFromUrl = searchParams.get("externalAgentId");
  const userIdFromUrl = searchParams.get("userId");
  const sortByFromUrl = searchParams.get("sortBy");
  const sortDirectionFromUrl = searchParams.get("sortDirection");

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);

  const [profileFilter, setProfileFilter] = useState(profileIdFromUrl || "all");
  const [externalAgentIdFilter, setExternalAgentIdFilter] = useState(
    externalAgentIdFromUrl || "",
  );
  const [userIdFilter, setUserIdFilter] = useState(userIdFromUrl || "");
  const [sorting, setSorting] = useState<SortingState>([
    {
      id: sortByFromUrl || "createdAt",
      desc: sortDirectionFromUrl !== "asc",
    },
  ]);

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
      updateUrlParams({
        page: String(newPagination.pageIndex + 1),
        pageSize: String(newPagination.pageSize),
      });
    },
    [updateUrlParams],
  );

  const handleProfileFilterChange = useCallback(
    (value: string) => {
      setProfileFilter(value);
      updateUrlParams({
        profileId: value === "all" ? null : value,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const handleExternalAgentIdFilterChange = useCallback(
    (value: string) => {
      setExternalAgentIdFilter(value);
      updateUrlParams({
        externalAgentId: value || null,
        page: "1", // Reset to first page
      });
    },
    [updateUrlParams],
  );

  const handleUserIdFilterChange = useCallback(
    (value: string) => {
      setUserIdFilter(value);
      updateUrlParams({
        userId: value || null,
        page: "1", // Reset to first page
      });
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

  // Convert TanStack sorting to API format
  const sortBy = sorting[0]?.id;
  const sortDirection = sorting[0]?.desc ? "desc" : "asc";

  // Map UI column ids to API sort fields
  // Note: userId is added as a valid sort field but type may need codegen update
  const sortByMapping: Record<string, string> = {
    agent: "profileId",
    externalAgentId: "externalAgentId",
    user: "userId",
    "request.model": "model",
    createdAt: "createdAt",
  };
  const apiSortBy = sortBy
    ? (sortByMapping[sortBy] as NonNullable<
        archestraApiTypes.GetInteractionsData["query"]
      >["sortBy"])
    : undefined;

  const { data: interactionsResponse } = useInteractions({
    limit: pageSize,
    offset: pageIndex * pageSize,
    sortBy: apiSortBy,
    sortDirection,
    profileId: profileFilter !== "all" ? profileFilter : undefined,
    externalAgentId: externalAgentIdFilter || undefined,
    userId: userIdFilter || undefined,
    initialData: initialData?.interactions,
  });

  const { data: agents } = useProfiles({
    initialData: initialData?.agents,
  });

  const { data: uniqueExternalAgentIds } = useUniqueExternalAgentIds();

  const { data: uniqueUserIds } = useUniqueUserIds();

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
        const agent = agents?.find((a) => a.id === row.profileId);
        return agent?.name ?? "Unknown";
      },
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            Profile
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        const interaction = new DynamicInteraction(row.original);
        const agent = agents?.find((a) => a.id === interaction.profileId);
        return (
          <TruncatedText message={agent?.name ?? "Unknown"} maxLength={30} />
        );
      },
    },
    {
      id: "user",
      accessorKey: "userId",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            User
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        // Cast to access userId - types will be updated after codegen
        const userId = (row.original as { userId?: string | null }).userId;
        if (!userId) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        // Find user name from unique user IDs
        const userInfo = uniqueUserIds?.find(
          (u: { id: string }) => u.id === userId,
        );
        return (
          <TruncatedText
            message={userInfo?.name ?? userId}
            maxLength={20}
            className="text-xs"
          />
        );
      },
    },
    {
      id: "externalAgentId",
      accessorKey: "externalAgentId",
      header: ({ column }) => {
        return (
          <Button
            variant="ghost"
            className="h-auto !p-0 font-medium hover:bg-transparent"
            onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
          >
            External Agent ID
            <SortIcon isSorted={column.getIsSorted()} />
          </Button>
        );
      },
      cell: ({ row }) => {
        const externalAgentId = row.original.externalAgentId;
        if (!externalAgentId) {
          return <span className="text-xs text-muted-foreground">—</span>;
        }
        return (
          <TruncatedText
            message={externalAgentId}
            maxLength={20}
            className="font-mono text-xs"
          />
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
          <Badge variant="secondary" className="text-xs whitespace-normal">
            {interaction.provider} ({interaction.modelName})
          </Badge>
        );
      },
    },
    {
      id: "costSavings",
      header: "Cost Savings",
      cell: ({ row }) => {
        const {
          cost,
          baselineCost,
          toonCostSavings,
          toonTokensBefore,
          toonTokensAfter,
        } = row.original;

        // Calculate tokens saved for display
        const toonTokensSaved =
          toonTokensBefore &&
          toonTokensAfter &&
          toonTokensBefore > toonTokensAfter
            ? toonTokensBefore - toonTokensAfter
            : null;

        // Calculate actual savings amounts
        const costNum = cost ? Number.parseFloat(cost) : 0;
        const baselineCostNum = baselineCost
          ? Number.parseFloat(baselineCost)
          : 0;
        const toonCostSavingsNum = toonCostSavings
          ? Number.parseFloat(toonCostSavings)
          : 0;

        const costOptimizationSavings = baselineCostNum - costNum;
        const totalSavings = costOptimizationSavings + toonCostSavingsNum;

        // Show dash if there are no actual savings
        if (totalSavings === 0) {
          return <span className="text-xs text-muted-foreground">–</span>;
        }

        // If no cost optimization but has TOON compression, use cost as baseline
        const effectiveCost = cost || "0";
        const effectiveBaselineCost = baselineCost || cost || "0";

        return (
          <div className="text-xs">
            <Savings
              cost={effectiveCost}
              baselineCost={effectiveBaselineCost}
              toonCostSavings={toonCostSavings}
              toonTokensSaved={toonTokensSaved}
              format="percent"
              tooltip="hover"
              showUnifiedTooltip={true}
            />
          </div>
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
        const interaction = new DynamicInteraction(row.original);
        const assistantResponse = interaction.getLastAssistantResponse();
        const toolsRequested = interaction.getToolNamesRequested();

        // If there's no text response but tools are requested, show that
        if (
          (!assistantResponse || assistantResponse.trim() === "") &&
          toolsRequested.length > 0
        ) {
          return (
            <div className="text-xs text-muted-foreground italic">
              Requesting tool execution: {toolsRequested.join(", ")}
            </div>
          );
        }

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
        const toolsRequested = interaction.getToolNamesRequested();

        if (
          toolsUsed.length === 0 &&
          toolsBlocked.length === 0 &&
          toolsRequested.length === 0
        ) {
          return <span className="text-xs text-muted-foreground">None</span>;
        }

        return (
          <div className="flex flex-wrap gap-1">
            {toolsRequested.map((toolName) => (
              <ToolBadge
                key={`requested-${toolName}`}
                toolName={toolName}
                type="requested"
              />
            ))}
            {toolsUsed.map((toolName) => (
              <ToolBadge
                key={`used-${toolName}`}
                toolName={toolName}
                type="used"
              />
            ))}
            {toolsBlocked.map((toolName) => (
              <ToolBadge
                key={`blocked-${toolName}`}
                toolName={toolName}
                type="blocked"
              />
            ))}
          </div>
        );
      },
    },
  ];

  const hasFilters =
    profileFilter !== "all" ||
    externalAgentIdFilter.length > 0 ||
    userIdFilter.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-4">
        <SearchableSelect
          value={profileFilter}
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
          value={userIdFilter || "all"}
          onValueChange={(value) =>
            handleUserIdFilterChange(value === "all" ? "" : value)
          }
          placeholder="Filter by User"
          items={[
            { value: "all", label: "All Users" },
            ...(uniqueUserIds?.map((user: { id: string; name: string }) => ({
              value: user.id,
              label: user.name,
            })) || []),
          ]}
          className="w-[200px]"
        />

        <SearchableSelect
          value={externalAgentIdFilter || "all"}
          onValueChange={(value) =>
            handleExternalAgentIdFilterChange(value === "all" ? "" : value)
          }
          placeholder="Filter by External Agent ID"
          items={[
            { value: "all", label: "All External Agent IDs" },
            ...(uniqueExternalAgentIds?.map((id) => ({
              value: id,
              label: id,
            })) || []),
          ]}
          className="w-[250px]"
        />

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              handleProfileFilterChange("all");
              handleUserIdFilterChange("");
              handleExternalAgentIdFilterChange("");
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {!interactions || interactions.length === 0 ? (
        <p className="text-muted-foreground">
          {hasFilters
            ? "No logs match your filters. Try adjusting your search."
            : "No logs found"}
        </p>
      ) : (
        <DataTable
          columns={columns}
          data={interactions}
          pagination={
            paginationMeta
              ? {
                  pageIndex,
                  pageSize,
                  total: paginationMeta.total,
                }
              : undefined
          }
          manualPagination
          onPaginationChange={handlePaginationChange}
          manualSorting
          sorting={sorting}
          onSortingChange={handleSortingChange}
          onRowClick={(row) => {
            const interaction = new DynamicInteraction(row);
            router.push(`/logs/${interaction.id}`);
          }}
        />
      )}
    </div>
  );
}
