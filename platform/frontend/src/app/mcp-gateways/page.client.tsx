"use client";

import type { archestraApiTypes } from "@shared";
import { archestraApiSdk, E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  DollarSign,
  Eye,
  Plus,
  Search,
  Server,
  Shield,
  Tag,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentDialog } from "@/components/agent-dialog";
import { ConnectDialog } from "@/components/connect-dialog";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { McpConnectionInstructions } from "@/components/mcp-connection-instructions";
import { PageLayout } from "@/components/page-layout";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useDeleteProfile, useProfilesPaginated } from "@/lib/agent.query";
import {
  DEFAULT_AGENTS_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  formatDate,
} from "@/lib/utils";
import { McpGatewayActions } from "./mcp-gateway-actions";

type McpGatewaysInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"];
};

export default function McpGatewaysPage({
  initialData,
}: {
  initialData?: McpGatewaysInitialData;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <McpGateways initialData={initialData} />
      </ErrorBoundary>
    </div>
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

function TeamsBadges({
  teams,
}: {
  teams: Array<{ id: string; name: string }> | undefined;
}) {
  const MAX_TEAMS_TO_SHOW = 3;
  if (!teams || teams.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  const visibleTeams = teams.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teams.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleTeams.map((team) => (
        <Badge key={team.id} variant="secondary" className="text-xs">
          {team.name}
        </Badge>
      ))}
      {remainingTeams.length > 0 && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-xs text-muted-foreground cursor-help">
                +{remainingTeams.length} more
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <div className="flex flex-col gap-1">
                {remainingTeams.map((team) => (
                  <div key={team.id} className="text-xs">
                    {team.name}
                  </div>
                ))}
              </div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </div>
  );
}

function McpGateways({
  initialData,
}: {
  initialData?: McpGatewaysInitialData;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Get pagination/filter params from URL
  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | "toolsCount"
    | "team"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_AGENTS_PAGE_SIZE);
  const offset = pageIndex * pageSize;

  // Default sorting
  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: agentsResponse, isPending } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: ["mcp_gateway", "profile"],
  });

  const { data: _teams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams();
      return data || [];
    },
    initialData: initialData?.teams,
  });

  const [searchQuery, setSearchQuery] = useState(nameFilter);
  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  type GatewayData =
    archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingGateway, setConnectingGateway] = useState<{
    id: string;
    name: string;
    agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
  } | null>(null);
  const [editingGateway, setEditingGateway] = useState<GatewayData | null>(
    null,
  );
  const [deletingGatewayId, setDeletingGatewayId] = useState<string | null>(
    null,
  );

  // Update URL when search query changes
  const handleSearchChange = useCallback(
    (value: string) => {
      setSearchQuery(value);
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set("name", value);
      } else {
        params.delete("name");
      }
      params.set("page", "1"); // Reset to first page on search
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  // Update URL when sorting changes
  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const newSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(newSorting);

      const params = new URLSearchParams(searchParams.toString());
      if (newSorting.length > 0) {
        params.set("sortBy", newSorting[0].id);
        params.set("sortDirection", newSorting[0].desc ? "desc" : "asc");
      } else {
        params.delete("sortBy");
        params.delete("sortDirection");
      }
      params.set("page", "1"); // Reset to first page when sorting changes
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [sorting, searchParams, router, pathname],
  );

  // Update URL when pagination changes
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;
  const showLoading = isPending && !initialData?.agents;

  const columns: ColumnDef<GatewayData>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 300,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Name
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <div className="font-medium">
            <div className="flex items-center gap-2">
              {agent.name}
              {agent.agentType === "profile" && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="outline"
                        className="bg-orange-500/10 text-orange-600 border-orange-500/30 text-xs cursor-help"
                      >
                        Profile
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent>
                      This is a legacy entity that works both as MCP Gateway and
                      LLM Proxy
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              {agent.labels && agent.labels.length > 0 && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="inline-flex">
                        <Tag className="h-4 w-4 text-muted-foreground" />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent>
                      <div className="flex flex-wrap gap-1 max-w-xs">
                        {agent.labels.map((label) => (
                          <Badge
                            key={label.key}
                            variant="secondary"
                            className="text-xs"
                          >
                            <span className="font-semibold">{label.key}:</span>
                            <span className="ml-1">{label.value}</span>
                          </Badge>
                        ))}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        );
      },
    },
    {
      id: "createdAt",
      accessorKey: "createdAt",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Created
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <div className="font-mono text-xs">
          {formatDate({ date: row.original.createdAt })}
        </div>
      ),
    },
    {
      id: "toolsCount",
      accessorKey: "toolsCount",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Tools
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const toolsCount = row.original.tools.filter(
          (t) => !t.delegateToAgentId,
        ).length;
        return <div>{toolsCount}</div>;
      },
    },
    {
      id: "subagentsCount",
      header: "Subagents",
      cell: ({ row }) => {
        const subagentsCount = row.original.tools.filter(
          (t) => t.delegateToAgentId,
        ).length;
        return <div>{subagentsCount}</div>;
      },
    },
    {
      id: "team",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Teams
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => (
        <TeamsBadges
          teams={
            row.original.teams as unknown as Array<{
              id: string;
              name: string;
            }>
          }
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 176,
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <McpGatewayActions
            agent={agent}
            onConnect={setConnectingGateway}
            onEdit={(agentData) => {
              setEditingGateway(agentData);
            }}
            onDelete={setDeletingGatewayId}
          />
        );
      },
    },
  ];

  return (
    <LoadingWrapper
      isPending={showLoading}
      loadingFallback={<LoadingSpinner />}
    >
      <PageLayout
        title="MCP Gateways"
        description={
          <p className="text-sm text-muted-foreground">
            MCP Gateways provide a unified MCP endpoint for your AI agents to
            access tools and subagents.{" "}
            <a
              href="https://archestra.ai/docs/platform-mcp-gateway"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              Read more in the docs
            </a>
          </p>
        }
        actionButton={
          <PermissionButton
            permissions={{ profile: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
            data-testid={E2eTestId.CreateAgentButton}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create MCP Gateway
          </PermissionButton>
        }
      >
        <div>
          <div>
            <div className="mb-6">
              <div className="relative max-w-md">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <DebouncedInput
                  placeholder="Search gateways by name..."
                  initialValue={searchQuery}
                  onChange={handleSearchChange}
                  className="pl-9"
                />
              </div>
            </div>

            {!agents || agents.length === 0 ? (
              <div className="text-muted-foreground">
                {nameFilter
                  ? "No MCP gateways found matching your search"
                  : "No MCP gateways found"}
              </div>
            ) : (
              <div data-testid={E2eTestId.AgentsTable}>
                <DataTable
                  columns={columns}
                  data={agents}
                  sorting={sorting}
                  onSortingChange={handleSortingChange}
                  manualSorting={true}
                  manualPagination={true}
                  pagination={{
                    pageIndex,
                    pageSize,
                    total: pagination?.total || 0,
                  }}
                  onPaginationChange={handlePaginationChange}
                />
              </div>
            )}

            <AgentDialog
              open={isCreateDialogOpen}
              onOpenChange={setIsCreateDialogOpen}
              agentType="mcp_gateway"
              onCreated={(gateway) => {
                setIsCreateDialogOpen(false);
                setConnectingGateway({ ...gateway, agentType: "mcp_gateway" });
              }}
            />

            {connectingGateway && (
              <ConnectGatewayDialog
                agent={connectingGateway}
                open={!!connectingGateway}
                onOpenChange={(open) => !open && setConnectingGateway(null)}
              />
            )}

            <AgentDialog
              open={!!editingGateway}
              onOpenChange={(open) => !open && setEditingGateway(null)}
              agent={editingGateway}
              agentType={editingGateway?.agentType || "mcp_gateway"}
            />

            {deletingGatewayId && (
              <DeleteGatewayDialog
                agentId={deletingGatewayId}
                open={!!deletingGatewayId}
                onOpenChange={(open) => !open && setDeletingGatewayId(null)}
              />
            )}
          </div>
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

function GatewayConnectionColumns({
  agentId,
  agentType,
}: {
  agentId: string;
  agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
}) {
  const [activeTab, setActiveTab] = useState<"proxy" | "mcp">("mcp");

  return (
    <div className="space-y-6">
      {/* Tab Selection with inline features */}
      <div className="flex gap-3">
        <button
          type="button"
          onClick={() => setActiveTab("mcp")}
          className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
            activeTab === "mcp"
              ? "bg-green-500/5 border-2 border-green-500/30"
              : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
          }`}
        >
          <div className="flex items-center gap-2">
            <Shield
              className={`h-4 w-4 ${activeTab === "mcp" ? "text-green-500" : ""}`}
            />
            <span className="font-medium">MCP Gateway</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Server className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Unified MCP</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
          </div>
        </button>

        {/* Show LLM Proxy tab for profile type (backwards compatibility) */}
        {agentType === "profile" && (
          <button
            type="button"
            onClick={() => setActiveTab("proxy")}
            className={`flex-1 flex flex-col gap-2 p-3 rounded-lg transition-all duration-200 ${
              activeTab === "proxy"
                ? "bg-blue-500/5 border-2 border-blue-500/30"
                : "bg-muted/30 border-2 border-transparent hover:bg-muted/50"
            }`}
          >
            <div className="flex items-center gap-2">
              <Server
                className={`h-4 w-4 ${activeTab === "proxy" ? "text-blue-500" : ""}`}
              />
              <span className="font-medium">LLM Proxy</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
                <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
                <span className="text-[10px]">Observability</span>
              </div>
              <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
                <DollarSign className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
                <span className="text-[10px]">Cost</span>
              </div>
            </div>
          </button>
        )}
      </div>

      {/* Content - render all tabs, hide inactive ones to preload */}
      <div className="relative">
        <div className={activeTab === "mcp" ? "block" : "hidden"}>
          <div className="p-4 rounded-lg border bg-card">
            <McpConnectionInstructions agentId={agentId} hideProfileSelector />
          </div>
        </div>
        {agentType === "profile" && (
          <div className={activeTab === "proxy" ? "block" : "hidden"}>
            <div className="p-4 rounded-lg border bg-card">
              <ProxyConnectionInstructions agentId={agentId} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ConnectGatewayDialog({
  agent,
  open,
  onOpenChange,
}: {
  agent: {
    id: string;
    name: string;
    agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
  };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <ConnectDialog
      agent={agent}
      open={open}
      onOpenChange={onOpenChange}
      docsPage="platform-mcp-gateway"
    >
      <GatewayConnectionColumns
        agentId={agent.id}
        agentType={agent.agentType}
      />
    </ConnectDialog>
  );
}

function DeleteGatewayDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteGateway = useDeleteProfile();

  const handleDelete = useCallback(async () => {
    const result = await deleteGateway.mutateAsync(agentId);
    if (result) {
      toast.success("MCP Gateway deleted successfully");
      onOpenChange(false);
    }
  }, [agentId, deleteGateway, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete MCP Gateway</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this MCP Gateway? This action cannot
            be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleteGateway.isPending}
          >
            {deleteGateway.isPending ? "Deleting..." : "Delete MCP Gateway"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
