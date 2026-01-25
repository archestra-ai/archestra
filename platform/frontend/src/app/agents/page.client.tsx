"use client";

import type { archestraApiTypes } from "@shared";
import { archestraApiSdk, E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Grip,
  Plus,
  Search,
  Tag,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { AgentDialog } from "@/components/agent-dialog";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { DebouncedInput } from "@/components/debounced-input";
import { LoadingSpinner } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
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
import {
  useDeleteProfile,
  useProfilesPaginated,
  useProfilesQuery,
} from "@/lib/agent.query";
import {
  DEFAULT_AGENTS_PAGE_SIZE,
  DEFAULT_SORT_BY,
  DEFAULT_SORT_DIRECTION,
  formatDate,
} from "@/lib/utils";
import { AgentActions } from "./agent-actions";

type AgentsInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"];
};

export default function AgentsPage({
  initialData,
}: {
  initialData?: AgentsInitialData;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <Suspense fallback={<LoadingSpinner />}>
          <Agents initialData={initialData} />
        </Suspense>
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

function Agents({ initialData }: { initialData?: AgentsInitialData }) {
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

  const { data: agentsResponse } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: ["agent"],
  });

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;

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

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<{
    id: string;
    name: string;
    agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
  } | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentData | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);

  // Handle 'create' URL parameter to open the Create Agent dialog
  useEffect(() => {
    if (searchParams.get("create") === "true") {
      setIsCreateDialogOpen(true);
      // Remove the 'create' parameter from URL after opening the dialog
      const newParams = new URLSearchParams(searchParams);
      newParams.delete("create");
      router.replace(`${pathname}?${newParams.toString()}`);
    }
  }, [searchParams, pathname, router]);
  const [versionHistoryAgent, setVersionHistoryAgent] =
    useState<AgentData | null>(null);

  type AgentData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

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

  const columns: ColumnDef<AgentData>[] = [
    {
      id: "name",
      accessorKey: "name",
      size: 200,
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
      size: 200,
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        return (
          <AgentActions
            agent={agent}
            onConnect={setConnectingAgent}
            onEdit={(agentData) => {
              setEditingAgent(agentData);
            }}
            onDelete={setDeletingAgentId}
          />
        );
      },
    },
  ];

  return (
    <PageLayout
      title="Agents"
      description={
        <p className="text-sm text-muted-foreground">
          Agents are internal AI assistants with system prompts, tools, and
          integrations like ChatOps, email, and A2A.{" "}
          <a
            href="https://archestra.ai/docs/platform-agents"
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
          Create Agent
        </PermissionButton>
      }
    >
      <div>
        <div>
          <div className="mb-6 flex items-center gap-4">
            <Button variant="outline" asChild>
              <Link href="/agents/builder">
                <Grip className="mr-2 h-4 w-4" />
                Agent Builder
              </Link>
            </Button>
            <div className="relative max-w-md flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <DebouncedInput
                placeholder="Search agents by name..."
                initialValue={searchQuery}
                onChange={handleSearchChange}
                className="pl-9"
              />
            </div>
          </div>

          {!agents || agents.length === 0 ? (
            <div className="text-muted-foreground">
              {nameFilter
                ? "No agents found matching your search"
                : "No agents found"}
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
            agentType="agent"
            onCreated={(agent) => {
              setIsCreateDialogOpen(false);
              setConnectingAgent({ ...agent, agentType: "agent" });
            }}
            onViewVersionHistory={setVersionHistoryAgent}
          />

          {connectingAgent && (
            <ConnectAgentDialog
              agent={connectingAgent}
              open={!!connectingAgent}
              onOpenChange={(open) => !open && setConnectingAgent(null)}
            />
          )}

          <AgentDialog
            open={!!editingAgent}
            onOpenChange={(open) => !open && setEditingAgent(null)}
            agent={editingAgent}
            agentType="agent"
            onViewVersionHistory={setVersionHistoryAgent}
          />

          <PromptVersionHistoryDialog
            open={!!versionHistoryAgent}
            onOpenChange={(open) => {
              if (!open) {
                setVersionHistoryAgent(null);
              }
            }}
            agent={versionHistoryAgent}
          />

          {deletingAgentId && (
            <DeleteAgentDialog
              agentId={deletingAgentId}
              open={!!deletingAgentId}
              onOpenChange={(open) => !open && setDeletingAgentId(null)}
            />
          )}
        </div>
      </div>
    </PageLayout>
  );
}

function AgentConnectionColumns({ agentId }: { agentId: string }) {
  // Fetch agent data for A2A connection instructions (non-suspense to avoid loading flicker)
  const { data: profiles } = useProfilesQuery();
  const agent = profiles?.find((p) => p.id === agentId);

  if (!agent) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border bg-card">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-8">
            <LoadingSpinner />
          </div>
        }
      >
        <A2AConnectionInstructions agent={agent} />
      </Suspense>
    </div>
  );
}

function ConnectAgentDialog({
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-5xl h-[90vh] p-0 flex flex-col border-0">
        {/* Header with gradient */}
        <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-background px-6 pt-6 pb-5 shrink-0">
          <div className="absolute inset-0 bg-grid-white/[0.02] pointer-events-none" />
          <div className="relative">
            <DialogHeader>
              <div className="flex items-center gap-2 mb-1">
                <div className="p-1.5 rounded-full bg-primary/10">
                  <Bot className="h-4 w-4 text-primary" />
                </div>
                <DialogTitle className="text-xl font-semibold">
                  Connect to "{agent.name}"
                </DialogTitle>
              </div>
            </DialogHeader>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <AgentConnectionColumns agentId={agent.id} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t bg-muted/30 shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ExternalLink className="h-3.5 w-3.5" />
            <span>Need help? Check our</span>
            <a
              href="https://archestra.ai/docs/platform-agents"
              target="_blank"
              className="text-primary hover:underline font-medium"
              rel="noopener"
            >
              documentation
            </a>
          </div>
          <Button
            type="button"
            onClick={() => onOpenChange(false)}
            size="default"
            className="min-w-[100px]"
          >
            Done
            <ArrowRight className="ml-2 h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DeleteAgentDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteAgent = useDeleteProfile();

  const handleDelete = useCallback(async () => {
    try {
      await deleteAgent.mutateAsync(agentId);
      toast.success("Agent deleted successfully");
      onOpenChange(false);
    } catch (_error) {
      toast.error("Failed to delete agent");
    }
  }, [agentId, deleteAgent, onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Delete Agent</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete this agent? This action cannot be
            undone.
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
            disabled={deleteAgent.isPending}
          >
            {deleteAgent.isPending ? "Deleting..." : "Delete Agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
