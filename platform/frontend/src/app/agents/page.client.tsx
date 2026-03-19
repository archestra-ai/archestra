"use client";

import {
  type AgentType,
  archestraApiSdk,
  type archestraApiTypes,
  E2eTestId,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Globe, Plus, User, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { A2AConnectionInstructions } from "@/components/a2a-connection-instructions";
import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  ActiveFilterBadges,
  AgentScopeFilter,
} from "@/components/agent-scope-filter";
import {
  ConnectDialog,
  ConnectDialogSection,
} from "@/components/connect-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
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
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/lib/utils";
import { AgentActions } from "./agent-actions";

type AgentsInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
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

function SortIcon({
  isSorted,
}: {
  isSorted:
    | NonNullable<archestraApiTypes.GetAgentsData["query"]>["sortDirection"]
    | false;
}) {
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
  const MAX_BADGE_TEXT_LENGTH = 15;

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
      <Badge
        variant="secondary"
        className="inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs"
      >
        <User className="h-3 w-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {truncateBadgeText(displayName, MAX_BADGE_TEXT_LENGTH)}
        </span>
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
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {visibleTeams.map((team) => (
        <Badge
          key={team.id}
          variant="secondary"
          className="inline-flex max-w-[180px] items-center gap-1 overflow-hidden text-xs"
        >
          <Users className="h-3 w-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {truncateBadgeText(team.name, MAX_BADGE_TEXT_LENGTH)}
          </span>
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
  function truncateBadgeText(text: string, maxLength: number) {
    if (text.length <= maxLength) {
      return text;
    }

    return `${text.slice(0, maxLength)}...`;
  }
}

function Agents({ initialData }: { initialData?: AgentsInitialData }) {
  const {
    searchParams,
    pathname,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const router = useRouter();

  // Get pagination/filter params from URL
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
  const excludeAuthorIdsFromUrl = searchParams.get("excludeAuthorIds");
  const labelsFromUrl = searchParams.get("labels");

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
    excludeAuthorIds: excludeAuthorIdsFromUrl
      ? excludeAuthorIdsFromUrl.split(",")
      : undefined,
    labels: labelsFromUrl || undefined,
  });

  // Keep teams cache warm for AgentDialog
  const { data: userTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return data?.data || [];
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
    agentType: AgentType;
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
    },
    [sorting, updateQueryParams],
  );

  // Update URL when pagination changes
  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPagination(newPagination);
    },
    [setPagination],
  );

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;
  const showLoading = isPending && !initialData?.agents;
  const hasActiveFilters = !!(nameFilter || scopeFromUrl || labelsFromUrl);

  const clearFilters = useCallback(() => {
    updateQueryParams({
      page: "1",
      name: null,
      scope: null,
      teamIds: null,
      authorIds: null,
      excludeAuthorIds: null,
      labels: null,
    });
  }, [updateQueryParams]);

  const columns: ColumnDef<AgentData>[] = [
    {
      id: "icon",
      size: 40,
      enableSorting: false,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <AgentIcon icon={row.original.icon} size={20} />
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      size: 240,
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
          <AgentNameCell
            name={agent.name}
            scope={agent.scope}
            builtIn={agent.builtIn ?? undefined}
            description={agent.description}
            labels={agent.labels}
          />
        );
      },
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
      id: "knowledgeSourcesCount",
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Knowledge Sources
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const count =
          (row.original.knowledgeBaseIds?.length ?? 0) +
          (row.original.connectorIds?.length ?? 0);
        return <div>{count}</div>;
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
                scope={row.original.scope}
                teams={row.original.teams}
                authorId={row.original.authorId}
                authorName={row.original.authorName}
                currentUserId={currentUserId}
              />
            ),
          } satisfies ColumnDef<AgentData>,
        ]
      : []),
    {
      id: "actions",
      header: "Actions",
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        const scope = agent.scope;
        const authorId = agent.authorId;
        const agentTeams = agent.teams;
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
            Agents are AI assistants with system prompts, tools, knowledge
            sources, and integrations like ChatOps, email, and A2A.
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
                  objectNamePlural="agents"
                  searchFields={["name"]}
                  paramName="name"
                />
                <AgentScopeFilter showBuiltIn />
              </div>
              <ActiveFilterBadges />
            </div>

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
                  total: pagination?.total ?? 0,
                }}
                onPaginationChange={handlePaginationChange}
                emptyMessage="No agents found"
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage="No agents match your filters. Try adjusting your search."
                onClearFilters={clearFilters}
              />
            </div>

            <AgentDialog
              open={isCreateDialogOpen}
              onOpenChange={setIsCreateDialogOpen}
              agentType="agent"
              onCreated={() => {
                setIsCreateDialogOpen(false);
              }}
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
    <div className="space-y-6">
      <ConnectDialogSection
        title="A2A Connection"
        description="Connect directly to this agent with Archestra's A2A endpoint, tokens, deep links, and optional email invocation."
      >
        <A2AConnectionInstructions agent={agent} />
      </ConnectDialogSection>
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
    agentType: AgentType;
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
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Agent"
      description="Are you sure you want to delete this agent? This action cannot be undone."
      isPending={deleteAgent.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Agent"
      pendingLabel="Deleting..."
    />
  );
}
