"use client";

import {
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  E2eTestId,
  getDocsUrl,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Globe, Plus, User, Users } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { AgentBadge } from "@/components/agent-badge";
import { AgentDialog } from "@/components/agent-dialog";
import {
  ActiveFilterBadges,
  AgentScopeFilter,
} from "@/components/agent-scope-filter";
import { PromptVersionHistoryDialog } from "@/components/chat/prompt-version-history-dialog";
import { ConnectDialog } from "@/components/connect-dialog";
import { LabelTags } from "@/components/label-tags";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogForm,
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
  useProfile,
  useProfiles,
  useProfilesPaginated,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
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
        <Agents initialData={initialData} />
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

function VisibilityBadge({
  scope,
  teams,
  authorId,
  authorName,
  currentUserId,
}: {
  scope: string | undefined;
  teams: Array<{ id: string; name: string }> | undefined;
  authorId: string | null | undefined;
  authorName: string | null | undefined;
  currentUserId: string | undefined;
}) {
  const MAX_TEAMS_TO_SHOW = 3;

  if (scope === "org") {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <Globe className="h-3 w-3" />
        Organization
      </Badge>
    );
  }

  if (scope === "personal") {
    const displayName =
      currentUserId && authorId === currentUserId ? "Me" : authorName;
    if (!displayName) return <span className="text-muted-foreground">-</span>;
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <User className="h-3 w-3" />
        {displayName}
      </Badge>
    );
  }

  // scope === "team" or undefined
  const hasTeams = teams && teams.length > 0;

  if (!hasTeams) {
    return <span className="text-muted-foreground">-</span>;
  }

  const visibleTeams = teams.slice(0, MAX_TEAMS_TO_SHOW);
  const remainingTeams = teams.slice(MAX_TEAMS_TO_SHOW);

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {visibleTeams.map((team) => (
        <Badge key={team.id} variant="secondary" className="text-xs gap-1">
          <Users className="h-3 w-3" />
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
    | "subagentsCount"
    | "team"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;
  const scopeFromUrl = searchParams.get("scope") as
    | "personal"
    | "team"
    | "org"
    | "built_in"
    | null;
  const teamIdsFromUrl = searchParams.get("teamIds");
  const authorIdsFromUrl = searchParams.get("authorIds");
  const labelsFromUrl = searchParams.get("labels");

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
    agentTypes: ["agent"],
    scope: scopeFromUrl || undefined,
    teamIds: teamIdsFromUrl ? teamIdsFromUrl.split(",") : undefined,
    authorIds: authorIdsFromUrl ? authorIdsFromUrl.split(",") : undefined,
    labels: labelsFromUrl || undefined,
  });

  // Keep teams cache warm for AgentDialog
  const { data: userTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams();
      return data || [];
    },
    initialData: initialData?.teams,
  });

  const { data: isAgentAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isAgentTeamAdmin } = useHasPermissions({
    agent: ["team-admin"],
  });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));

  // Users can always create personal agents, no team requirement needed

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  // Sync sorting state with URL params
  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  type AgentData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingAgent, setConnectingAgent] = useState<{
    id: string;
    name: string;
    agentType: "profile" | "mcp_gateway" | "llm_proxy" | "agent";
  } | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentData | null>(null);
  const [deletingAgentId, setDeletingAgentId] = useState<string | null>(null);
  const [versionHistoryAgent, setVersionHistoryAgent] =
    useState<AgentData | null>(null);

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

  // Handle 'edit' URL parameter to open the Edit Agent dialog
  const editAgentId = searchParams.get("edit");
  const { data: editAgentData } = useProfile(editAgentId ?? undefined);
  useEffect(() => {
    if (editAgentId && editAgentData && !editingAgent) {
      setEditingAgent(editAgentData as AgentData);
      const newParams = new URLSearchParams(searchParams);
      newParams.delete("edit");
      router.replace(`${pathname}?${newParams.toString()}`);
    }
  }, [
    editAgentId,
    editAgentData,
    editingAgent,
    searchParams,
    pathname,
    router,
  ]);

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

  const columns: ColumnDef<AgentData>[] = [
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
        const scope = agent.scope;
        return (
          <div className="font-medium">
            <div className="flex items-start gap-2">
              <span className="break-words min-w-0">{agent.name}</span>
              <AgentBadge type={agent.builtIn ? "builtIn" : scope} />
              {agent.labels && agent.labels.length > 0 && (
                <LabelTags labels={agent.labels} />
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
      accessorKey: "subagentsCount",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Subagents
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const subagentsCount = row.original.tools.filter(
          (t) => t.delegateToAgentId,
        ).length;
        return <div>{subagentsCount}</div>;
      },
    },
    ...(isAgentAdmin
      ? [
          {
            id: "team",
            header: "Accessible to",
            enableSorting: false,
            cell: ({ row }: { row: { original: AgentData } }) => (
              <VisibilityBadge
                scope={
                  (row.original as unknown as Record<string, unknown>)
                    .scope as string
                }
                teams={
                  row.original.teams as unknown as Array<{
                    id: string;
                    name: string;
                  }>
                }
                authorId={
                  (row.original as unknown as Record<string, unknown>)
                    .authorId as string | null
                }
                authorName={
                  (row.original as unknown as Record<string, unknown>)
                    .authorName as string | null
                }
                currentUserId={currentUserId}
              />
            ),
          } satisfies ColumnDef<AgentData>,
        ]
      : []),
    {
      id: "actions",
      header: "Actions",
      size: 200,
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        const scope = (agent as unknown as Record<string, unknown>).scope as
          | string
          | undefined;
        const authorId = (agent as unknown as Record<string, unknown>)
          .authorId as string | null | undefined;
        const agentTeams = (
          agent as unknown as { teams?: Array<{ id: string }> }
        ).teams;
        const isPersonal = scope === "personal";
        const isTeamScoped = scope === "team";
        const isOwner = !!currentUserId && authorId === currentUserId;
        const isMemberOfAgentTeam = agentTeams?.some((t) =>
          userTeamIdSet.has(t.id),
        );
        const canModify =
          !!isAgentAdmin ||
          (isTeamScoped && !!isAgentTeamAdmin && !!isMemberOfAgentTeam) ||
          (isPersonal && isOwner);
        return (
          <AgentActions
            agent={agent}
            canModify={canModify}
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
    <LoadingWrapper
      isPending={showLoading}
      loadingFallback={<LoadingSpinner />}
    >
      <PageLayout
        title="Agents"
        description={
          <p className="text-sm text-muted-foreground">
            Agents are internal AI assistants with system prompts, tools, and
            integrations like ChatOps, email, and A2A.{" "}
            <a
              href={getDocsUrl(DocsPage.PlatformAgents)}
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
            permissions={{ agent: ["create"] }}
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
            <div className="mb-6 flex flex-col gap-2">
              <div className="flex items-center gap-4">
                <SearchInput
                  placeholder="Search agents by name..."
                  paramName="name"
                  className="relative max-w-md flex-1"
                />
                <AgentScopeFilter showBuiltIn />
              </div>
              <ActiveFilterBadges />
            </div>

            {!agents || agents.length === 0 ? (
              <div className="text-muted-foreground">
                {nameFilter || scopeFromUrl || labelsFromUrl
                  ? "No agents found matching your filters"
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
              onCreated={() => {
                setIsCreateDialogOpen(false);
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
    </LoadingWrapper>
  );
}

function AgentConnectionColumns({ agentId }: { agentId: string }) {
  // Fetch agent data for A2A connection instructions
  const { data: profiles, isPending } = useProfiles();
  const agent = profiles?.find((p) => p.id === agentId);

  if (isPending || !agent) {
    return (
      <div className="flex items-center justify-center py-8">
        <LoadingSpinner />
      </div>
    );
  }

  return (
    <div className="p-4 rounded-lg border bg-card">
      <A2AConnectionInstructions agent={agent} />
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
    <ConnectDialog
      agent={agent}
      open={open}
      onOpenChange={onOpenChange}
      docsPage="platform-agents"
    >
      <AgentConnectionColumns agentId={agent.id} />
    </ConnectDialog>
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
    const result = await deleteAgent.mutateAsync(agentId);
    if (result) {
      toast.success("Agent deleted successfully");
      onOpenChange(false);
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
        <DialogForm onSubmit={handleDelete}>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="destructive"
              disabled={deleteAgent.isPending}
            >
              {deleteAgent.isPending ? "Deleting..." : "Delete Agent"}
            </Button>
          </DialogFooter>
        </DialogForm>
      </DialogContent>
    </Dialog>
  );
}
