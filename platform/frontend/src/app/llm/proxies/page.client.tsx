"use client";

import {
  type AgentType,
  archestraApiSdk,
  type archestraApiTypes,
  DocsPage,
  E2eTestId,
  getDocsUrl,
} from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  DollarSign,
  Eye,
  Globe,
  Lock,
  Network,
  Plus,
  User,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentBadge } from "@/components/agent-badge";
import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon } from "@/components/agent-icon";
import {
  ActiveFilterBadges,
  AgentScopeFilter,
} from "@/components/agent-scope-filter";
import { ConnectDialog } from "@/components/connect-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LabelTags } from "@/components/label-tags";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { ProxyConnectionInstructions } from "@/components/proxy-connection-instructions";
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
import { useDeleteProfile, useProfilesPaginated } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { useDataTableQueryParams } from "@/lib/use-data-table-query-params";
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/lib/utils";
import { LlmProxyActions } from "./llm-proxy-actions";

type LlmProxiesInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
};

export default function LlmProxiesPage({
  initialData,
}: {
  initialData?: LlmProxiesInitialData;
}) {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <LlmProxies initialData={initialData} />
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

  const scopeBadge =
    scope === "org" ? (
      <Badge variant="secondary" className="text-xs gap-1">
        <Globe className="h-3 w-3" />
        Organization
      </Badge>
    ) : scope === "personal" ? (
      (() => {
        const displayName =
          currentUserId && authorId === currentUserId ? "Me" : authorName;
        return displayName ? (
          <Badge variant="secondary" className="text-xs gap-1">
            <User className="h-3 w-3" />
            {displayName}
          </Badge>
        ) : null;
      })()
    ) : null;

  const hasTeams = teams && teams.length > 0;

  if (!scopeBadge && !hasTeams) {
    return (
      <Badge variant="secondary" className="text-xs gap-1">
        <Users className="h-3 w-3" />
        Team
      </Badge>
    );
  }

  const visibleTeams = hasTeams ? teams.slice(0, MAX_TEAMS_TO_SHOW) : [];
  const remainingTeams = hasTeams ? teams.slice(MAX_TEAMS_TO_SHOW) : [];

  return (
    <div className="flex items-center gap-1 flex-wrap">
      {scopeBadge}
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

function LlmProxies({ initialData }: { initialData?: LlmProxiesInitialData }) {
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();

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

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;

  const { data: agentsResponse, isPending } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: ["llm_proxy", "profile"],
    scope: scopeFromUrl || undefined,
    teamIds: teamIdsFromUrl ? teamIdsFromUrl.split(",") : undefined,
    authorIds: authorIdsFromUrl ? authorIdsFromUrl.split(",") : undefined,
    excludeAuthorIds: excludeAuthorIdsFromUrl
      ? excludeAuthorIdsFromUrl.split(",")
      : undefined,
    labels: labelsFromUrl || undefined,
  });

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

  const { data: isAdmin } = useHasPermissions({ llmProxy: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    llmProxy: ["team-admin"],
  });
  const { data: session } = authClient.useSession();
  const currentUserId = session?.user?.id;
  const userTeamIdSet = new Set((userTeams ?? []).map((t) => t.id));

  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  type ProxyData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [connectingProxy, setConnectingProxy] = useState<{
    id: string;
    name: string;
    agentType: AgentType;
  } | null>(null);
  const [editingProxy, setEditingProxy] = useState<ProxyData | null>(null);
  const [deletingProxyId, setDeletingProxyId] = useState<string | null>(null);

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

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      setPagination(newPagination);
    },
    [setPagination],
  );

  const agents = agentsResponse?.data || [];
  const pagination = agentsResponse?.pagination;
  const showLoading = isPending && !initialData?.agents;

  const columns: ColumnDef<ProxyData>[] = [
    {
      id: "icon",
      size: 40,
      enableSorting: false,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <AgentIcon
            icon={row.original.icon}
            size={20}
            fallbackType="llm_proxy"
          />
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
        const scope = agent.scope;
        return (
          <div className="font-medium">
            <div className="flex items-center gap-2">
              {agent.name}
              <AgentBadge type={scope} />
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
                <LabelTags labels={agent.labels} />
              )}
            </div>
          </div>
        );
      },
    },
    ...(isAdmin
      ? [
          {
            id: "team",
            header: "Accessible to",
            enableSorting: false,
            cell: ({ row }: { row: { original: ProxyData } }) => (
              <VisibilityBadge
                scope={row.original.scope}
                teams={row.original.teams}
                authorId={row.original.authorId}
                authorName={row.original.authorName}
                currentUserId={currentUserId}
              />
            ),
          } satisfies ColumnDef<ProxyData>,
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
          !!isAdmin ||
          (isTeamScoped && !!isTeamAdmin && !!isMemberOfAgentTeam) ||
          (isPersonal && isOwner);
        return (
          <LlmProxyActions
            agent={agent}
            canModify={canModify}
            onConnect={setConnectingProxy}
            onEdit={(agentData) => {
              setEditingProxy(agentData);
            }}
            onDelete={setDeletingProxyId}
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
        title="LLM Proxies"
        description={
          <p className="text-sm text-muted-foreground">
            LLM Proxies provide security, observability, and cost management for
            your LLM API calls.{" "}
            <a
              href={getDocsUrl(DocsPage.PlatformLlmProxy)}
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
            permissions={{ llmProxy: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
            data-testid={E2eTestId.CreateAgentButton}
          >
            <Plus className="mr-2 h-4 w-4" />
            Create LLM Proxy
          </PermissionButton>
        }
      >
        <div>
          <div>
            <div className="mb-6 flex flex-col gap-2">
              <div className="flex items-center gap-4">
                <SearchInput
                  objectNamePlural="proxies"
                  searchFields={["name"]}
                  paramName="name"
                />
                <AgentScopeFilter />
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
                hasActiveFilters={Boolean(
                  nameFilter ||
                    scopeFromUrl ||
                    teamIdsFromUrl ||
                    authorIdsFromUrl ||
                    excludeAuthorIdsFromUrl ||
                    labelsFromUrl,
                )}
                onClearFilters={() =>
                  updateQueryParams({
                    name: null,
                    scope: null,
                    teamIds: null,
                    authorIds: null,
                    excludeAuthorIds: null,
                    labels: null,
                    page: "1",
                  })
                }
                emptyMessage="No LLM proxies found"
              />
            </div>

            <AgentDialog
              open={isCreateDialogOpen}
              onOpenChange={setIsCreateDialogOpen}
              agentType="llm_proxy"
              defaultIconType="llm_proxy"
              onCreated={(proxy) => {
                setIsCreateDialogOpen(false);
                setConnectingProxy({ ...proxy, agentType: "llm_proxy" });
              }}
            />

            {connectingProxy && (
              <ConnectProxyDialog
                agent={connectingProxy}
                open={!!connectingProxy}
                onOpenChange={(open) => !open && setConnectingProxy(null)}
              />
            )}

            <AgentDialog
              open={!!editingProxy}
              onOpenChange={(open) => !open && setEditingProxy(null)}
              agent={editingProxy}
              agentType={editingProxy?.agentType || "llm_proxy"}
              defaultIconType="llm_proxy"
            />

            {deletingProxyId && (
              <DeleteProxyDialog
                agentId={deletingProxyId}
                open={!!deletingProxyId}
                onOpenChange={(open) => !open && setDeletingProxyId(null)}
              />
            )}
          </div>
        </div>
      </PageLayout>
    </LoadingWrapper>
  );
}

function ProxyConnectionColumns({ agentId }: { agentId: string }) {
  return (
    <div className="space-y-6">
      <div className="flex gap-3">
        <div className="flex-1 flex flex-col gap-2 p-3 rounded-lg bg-blue-500/5 border-2 border-blue-500/30">
          <div className="flex items-center gap-2">
            <Network className="h-4 w-4 text-blue-500" />
            <span className="font-medium">LLM Proxy</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Lock className="h-2.5 w-2.5 text-blue-600 dark:text-blue-400" />
              <span className="text-[10px]">Security</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <Eye className="h-2.5 w-2.5 text-purple-600 dark:text-purple-400" />
              <span className="text-[10px]">Observability</span>
            </div>
            <div className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-background/60 border border-border/50">
              <DollarSign className="h-2.5 w-2.5 text-green-600 dark:text-green-400" />
              <span className="text-[10px]">Cost</span>
            </div>
          </div>
        </div>
      </div>

      <div className="p-4 rounded-lg border bg-card">
        <ProxyConnectionInstructions agentId={agentId} />
      </div>
    </div>
  );
}

function ConnectProxyDialog({
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
      docsPage="platform-llm-proxy"
    >
      <ProxyConnectionColumns agentId={agent.id} />
    </ConnectDialog>
  );
}

function DeleteProxyDialog({
  agentId,
  open,
  onOpenChange,
}: {
  agentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteProxy = useDeleteProfile();

  const handleDelete = useCallback(async () => {
    const result = await deleteProxy.mutateAsync(agentId);
    if (result) {
      toast.success("LLM Proxy deleted successfully");
      onOpenChange(false);
    }
  }, [agentId, deleteProxy, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete LLM Proxy"
      description="Are you sure you want to delete this LLM Proxy? This action cannot be undone."
      isPending={deleteProxy.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete LLM Proxy"
      pendingLabel="Deleting..."
    />
  );
}
