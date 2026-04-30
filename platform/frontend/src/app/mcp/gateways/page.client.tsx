"use client";

import { archestraApiSdk, type archestraApiTypes, E2eTestId } from "@shared";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentDialog } from "@/components/agent-dialog";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  ActiveFilterBadges,
  AgentScopeFilter,
} from "@/components/agent-scope-filter";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
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
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";
import {
  useDeleteProfile,
  useProfile,
  useProfilesPaginated,
} from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { authClient } from "@/lib/clients/auth/auth-client";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { McpGatewayActions } from "./mcp-gateway-actions";

type McpGatewaysInitialData = {
  agents: archestraApiTypes.GetAgentsResponses["200"] | null;
  teams: archestraApiTypes.GetTeamsResponses["200"]["data"];
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

function McpGateways({
  initialData,
}: {
  initialData?: McpGatewaysInitialData;
}) {
  const docsUrl = getFrontendDocsUrl("platform-mcp-gateway");
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

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const gatewayAgentTypes: Array<"mcp_gateway" | "profile"> = canReadAgents
    ? ["mcp_gateway", "profile"]
    : ["mcp_gateway"];

  const { data: agentsResponse, isPending } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: gatewayAgentTypes,
    scope: scopeFromUrl || undefined,
    teamIds: teamIdsFromUrl ? teamIdsFromUrl.split(",") : undefined,
    authorIds: authorIdsFromUrl ? authorIdsFromUrl.split(",") : undefined,
    excludeAuthorIds: excludeAuthorIdsFromUrl
      ? excludeAuthorIdsFromUrl.split(",")
      : undefined,
    excludeOtherPersonalAgents:
      scopeFromUrl !== "personal" &&
      !authorIdsFromUrl &&
      !excludeAuthorIdsFromUrl
        ? true
        : undefined,
    labels: labelsFromUrl || undefined,
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });

  const { data: userTeams } = useQuery({
    queryKey: ["teams"],
    queryFn: async () => {
      const { data } = await archestraApiSdk.getTeams({
        query: { limit: 100, offset: 0 },
      });
      return data?.data || [];
    },
    initialData: initialData?.teams,
    enabled: !!canReadTeams,
  });

  const { data: isAdmin } = useHasPermissions({ mcpGateway: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    mcpGateway: ["team-admin"],
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

  type GatewayData =
    archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  const router = useRouter();

  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(
    searchParams.get("create") === "true",
  );
  const editGatewayIdFromUrl = searchParams.get("edit");
  const openToolsFromUrl = searchParams.get("openTools") === "true";
  const { data: editGatewayFromUrl } = useProfile(
    editGatewayIdFromUrl ?? undefined,
  );
  const navigateToConnection = useCallback(
    (agentId: string) => {
      router.push(
        `/connection?gatewayId=${encodeURIComponent(agentId)}&from=table`,
      );
    },
    [router],
  );
  const [editingGateway, setEditingGateway] = useState<GatewayData | null>(
    null,
  );
  const [autoOpenedEditGatewayId, setAutoOpenedEditGatewayId] = useState<
    string | null
  >(null);
  useEffect(() => {
    if (
      editGatewayIdFromUrl &&
      editGatewayFromUrl &&
      editGatewayFromUrl.id !== autoOpenedEditGatewayId
    ) {
      setEditingGateway(editGatewayFromUrl as unknown as GatewayData);
      setAutoOpenedEditGatewayId(editGatewayFromUrl.id);
    }
  }, [editGatewayIdFromUrl, editGatewayFromUrl, autoOpenedEditGatewayId]);
  const [deletingGatewayId, setDeletingGatewayId] = useState<string | null>(
    null,
  );

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

  const columns: ColumnDef<GatewayData>[] = [
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
            fallbackType="mcp_gateway"
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
        return (
          <AgentNameCell
            name={agent.name}
            scope={agent.scope}
            description={agent.description}
            extraBadges={
              agent.agentType === "profile" ? (
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
              ) : null
            }
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
    ...(isAdmin
      ? [
          {
            id: "team",
            header: "Accessible to",
            enableSorting: false,
            cell: ({ row }: { row: { original: GatewayData } }) => (
              <ResourceVisibilityBadge
                scope={row.original.scope}
                teams={row.original.teams}
                authorId={row.original.authorId}
                authorName={row.original.authorName}
                currentUserId={currentUserId}
              />
            ),
          } satisfies ColumnDef<GatewayData>,
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
          <McpGatewayActions
            agent={agent}
            canModify={canModify}
            onConnect={(a) => navigateToConnection(a.id)}
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
            access tools and subagents.
            {docsUrl && (
              <>
                {" "}
                <ExternalDocsLink
                  href={docsUrl}
                  className="underline hover:text-foreground"
                  showIcon={false}
                >
                  Read more in the docs
                </ExternalDocsLink>
              </>
            )}
          </p>
        }
        actionButton={
          <PermissionButton
            permissions={{ mcpGateway: ["create"] }}
            onClick={() => setIsCreateDialogOpen(true)}
            data-testid={E2eTestId.CreateAgentButton}
          >
            <Plus className="h-4 w-4" />
            Create MCP Gateway
          </PermissionButton>
        }
      >
        <div>
          <div>
            <div className="mb-6 flex flex-col gap-2">
              <div className="flex items-center gap-4">
                <SearchInput
                  objectNamePlural="gateways"
                  searchFields={["name"]}
                  paramName="name"
                />
                <AgentScopeFilter ownerLabelPlural="MCP gateways" />
              </div>
              {!canReadTeams && (
                <PermissionRequirementHint
                  message="Team-based filters and sharing details are unavailable without"
                  permissions={[{ resource: "team", action: "read" }]}
                />
              )}
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
                emptyMessage="No MCP gateways found"
              />
            </div>

            <AgentDialog
              open={isCreateDialogOpen}
              onOpenChange={setIsCreateDialogOpen}
              agentType="mcp_gateway"
              defaultIconType="mcp_gateway"
              onCreated={() => {
                setIsCreateDialogOpen(false);
              }}
            />

            <AgentDialog
              open={!!editingGateway}
              onOpenChange={(open) => !open && setEditingGateway(null)}
              agent={editingGateway}
              agentType={editingGateway?.agentType || "mcp_gateway"}
              defaultIconType="mcp_gateway"
              openToolsCombobox={
                openToolsFromUrl &&
                editingGateway?.id === autoOpenedEditGatewayId
              }
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
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete MCP Gateway"
      description="Are you sure you want to delete this MCP Gateway? This action cannot be undone."
      isPending={deleteGateway.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete MCP Gateway"
      pendingLabel="Deleting..."
    />
  );
}
