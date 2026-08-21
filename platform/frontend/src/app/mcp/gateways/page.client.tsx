"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import type { ColumnDef, SortingState } from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { AgentIcon } from "@/components/agent-icon";
import { AgentNameCell } from "@/components/agent-name-cell";
import {
  AGENT_PAGE_CONFIGS,
  agentDetailHref,
  agentEditHref,
  agentNewHref,
  resolveLegacyAgentDialogRedirect,
} from "@/components/agent-pages/agent-page-config";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { computeCanModifyAgent } from "@/components/agent-pages/use-agent-access";
import { AgentVersionHistoryDialog } from "@/components/agent-version-history-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FilterBar, filterSearchClass } from "@/components/filter-bar";
import { LoadingSpinner, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PERMANENT_DELETE_LABEL } from "@/components/permanent-delete";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { QueryLoadError } from "@/components/query-load-error";
import {
  ActiveFilterBadges,
  ResourceDeletedStatusFilter,
  ResourceScopeFilter,
  useScopeFilterParams,
} from "@/components/resource-scope-filter";
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
  usePermanentlyDeleteProfile,
  useProfilesPaginated,
  useRestoreProfile,
} from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useMyTeams } from "@/lib/teams/team.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
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
    <div className="text-muted-foreground flex flex-col items-center">
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
  const router = useRouter();

  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy") as
    | "name"
    | "createdAt"
    | "toolsCount"
    | "subagentsCount"
    | "team"
    | "lastUsedAt"
    | null;
  const sortDirectionFromUrl = searchParams.get("sortDirection") as
    | "asc"
    | "desc"
    | null;
  const scopeFilter = useScopeFilterParams({ includeBuiltIn: true });
  const labelsFromUrl = searchParams.get("labels");
  const statusFromUrl = searchParams.get("status") as
    | "active"
    | "deleted"
    | null;
  const isDeletedView = statusFromUrl === "deleted";

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { data: canDeleteAgents } = useHasPermissions({ agent: ["delete"] });
  const gatewayAgentTypes: Array<"mcp_gateway" | "profile"> = canReadAgents
    ? isDeletedView && !canDeleteAgents
      ? ["mcp_gateway"]
      : ["mcp_gateway", "profile"]
    : ["mcp_gateway"];

  const {
    data: agentsResponse,
    isPending,
    isLoadingError: isGatewaysLoadError,
    refetch: refetchGateways,
  } = useProfilesPaginated({
    initialData: initialData?.agents ?? undefined,
    limit: pageSize,
    offset,
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: gatewayAgentTypes,
    scope: scopeFilter.scope,
    teamIds: scopeFilter.teamIds,
    authorIds: scopeFilter.authorIds,
    excludeAuthorIds: scopeFilter.excludeAuthorIds,
    excludeOtherPersonalAgents: scopeFilter.excludeOtherPersonal,
    labels: labelsFromUrl || undefined,
    status: statusFromUrl || undefined,
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });

  const { data: userTeams } = useMyTeams({
    enabled: !!canReadTeams,
  });

  const { data: isAdmin } = useHasPermissions({ mcpGateway: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    mcpGateway: ["team-admin"],
  });
  const { data: session } = useSession();
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

  // Create/edit used to be dialogs on this page, opened from `?create=true`
  // and `?edit=<id>` (plus `?openTools=true`); those links still arrive and
  // now land on the routed pages.
  useEffect(() => {
    const redirect = resolveLegacyAgentDialogRedirect(
      "mcp_gateway",
      searchParams,
    );
    if (redirect) router.replace(redirect);
  }, [searchParams, router]);
  const [deletingGatewayId, setDeletingGatewayId] = useState<string | null>(
    null,
  );
  // The row's scope check travels with the id: it is computed per row, and the
  // dialog's restore is an update that has to answer to it.
  const [history, setHistory] = useState<{
    id: string;
    canModify: boolean;
  } | null>(null);
  const [cloningGateway, setCloningGateway] = useState<GatewayData | null>(
    null,
  );
  const [permanentlyDeletingGateway, setPermanentlyDeletingGateway] =
    useState<GatewayData | null>(null);
  const restoreGateway = useRestoreProfile();
  const permanentlyDeleteGateway = usePermanentlyDeleteProfile("MCP Gateway");

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
            // A trashed gateway has no detail page: `GET /api/agents/:id`
            // filters deleted rows, so the link would land on "not found".
            href={
              agent.deletedAt
                ? undefined
                : agentDetailHref("mcp_gateway", agent.id)
            }
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
      size: 80,
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
      size: 100,
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
    {
      id: "lastUsedAt",
      accessorKey: "lastUsedAt",
      size: 110,
      header: ({ column }) => (
        <Button
          variant="ghost"
          className="h-auto !p-0 font-medium hover:bg-transparent"
          onClick={() => column.toggleSorting(column.getIsSorted() === "asc")}
        >
          Last used
          <SortIcon isSorted={column.getIsSorted()} />
        </Button>
      ),
      cell: ({ row }) => {
        const lastUsedAt = row.original.lastUsedAt;
        return (
          <span
            className="text-sm text-muted-foreground"
            title={
              lastUsedAt ? new Date(lastUsedAt).toLocaleString() : undefined
            }
          >
            {formatRelativeTimeFromNow(lastUsedAt ?? null)}
          </span>
        );
      },
    },
    {
      id: "team",
      header: "Accessible to",
      size: 140,
      enableSorting: false,
      cell: ({ row }) => (
        <RowClickShield>
          <ResourceVisibilityBadge
            scope={row.original.scope}
            teams={row.original.teams}
            users={row.original.users}
            authorId={row.original.authorId}
            authorName={row.original.authorName}
            currentUserId={currentUserId}
            showSelfAsMe
          />
        </RowClickShield>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      // Pixel-sized so the five icon buttons never clip: the actions column
      // keeps its px width while the sized columns scale down to fit.
      size: 200,
      enableHiding: false,
      cell: ({ row }) => {
        const agent = row.original;
        const canModify = computeCanModifyAgent({
          agent,
          isAdmin: !!isAdmin,
          isTeamAdmin: !!isTeamAdmin,
          currentUserId,
          userTeamIds: userTeamIdSet,
        });
        return (
          // The whole cell, so a disabled action's tooltip wrapper cannot let
          // the click through to the row either.
          <RowClickShield>
            <McpGatewayActions
              agent={agent}
              canModify={canModify}
              onConnect={(target) =>
                router.push(
                  agentDetailHref("mcp_gateway", target.id, "connect"),
                )
              }
              onEdit={(target) =>
                router.push(agentEditHref("mcp_gateway", target.id))
              }
              onDelete={setDeletingGatewayId}
              onRestore={(agentId) => {
                restoreGateway.mutate(agentId, {
                  onSuccess: (data) => {
                    if (!data) return;
                    toast.success("MCP Gateway restored successfully");
                  },
                });
              }}
              onPermanentlyDelete={setPermanentlyDeletingGateway}
              onClone={setCloningGateway}
              onHistory={(id, historyCanModify) =>
                setHistory({ id, canModify: historyCanModify })
              }
            />
          </RowClickShield>
        );
      },
    },
  ];

  if (isGatewaysLoadError) {
    return (
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
      >
        <QueryLoadError
          title="Couldn't load your MCP gateways"
          onRetry={() => refetchGateways()}
        />
      </PageLayout>
    );
  }

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
            onClick={() => router.push(agentNewHref("mcp_gateway"))}
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
              <FilterBar className="mb-0">
                <SearchInput
                  objectNamePlural="gateways"
                  searchFields={["name"]}
                  paramName="name"
                  className={filterSearchClass}
                />
                <ResourceScopeFilter
                  showLabels
                  ownerLabelPlural="MCP gateways"
                  adminPermission={{ mcpGateway: ["admin"] }}
                />
                <ResourceDeletedStatusFilter
                  deletePermission={{ mcpGateway: ["delete"] }}
                />
              </FilterBar>
              {!canReadTeams && (
                <PermissionRequirementHint
                  message="Team-based filters and sharing details are unavailable without"
                  permissions={[{ resource: "team", action: "read" }]}
                />
              )}
              <ActiveFilterBadges adminPermission={{ mcpGateway: ["admin"] }} />
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
                // Trashed rows have no page to open — Restore and permanent
                // delete stay row actions.
                onRowClick={
                  isDeletedView
                    ? undefined
                    : (row, event) =>
                        openRowOnPlainClick(event, () =>
                          router.push(agentDetailHref("mcp_gateway", row.id)),
                        )
                }
                hasActiveFilters={Boolean(
                  nameFilter ||
                    scopeFilter.hasActiveScopeFilters ||
                    labelsFromUrl ||
                    isDeletedView,
                )}
                onClearFilters={() =>
                  updateQueryParams({
                    name: null,
                    scope: null,
                    teamIds: null,
                    authorIds: null,
                    excludeAuthorIds: null,
                    labels: null,
                    status: null,
                    page: "1",
                  })
                }
                emptyMessage={
                  isDeletedView
                    ? "No deleted MCP gateways found"
                    : "No MCP gateways found"
                }
                filteredEmptyMessage={
                  isDeletedView
                    ? "No deleted MCP gateways found."
                    : "No MCP gateways match your filters. Try adjusting your search."
                }
              />
            </div>

            {deletingGatewayId && (
              <DeleteGatewayDialog
                agentId={deletingGatewayId}
                open={!!deletingGatewayId}
                onOpenChange={(open) => !open && setDeletingGatewayId(null)}
              />
            )}

            {permanentlyDeletingGateway && (
              <DeleteConfirmDialog
                open={!!permanentlyDeletingGateway}
                onOpenChange={(open) =>
                  !open && setPermanentlyDeletingGateway(null)
                }
                title="Delete MCP Gateway permanently"
                description={AGENT_PAGE_CONFIGS.mcp_gateway.permanentDeleteDescription(
                  permanentlyDeletingGateway.name,
                )}
                isPending={permanentlyDeleteGateway.isPending}
                onConfirm={() => {
                  permanentlyDeleteGateway.mutate(
                    permanentlyDeletingGateway.id,
                    {
                      onSuccess: (ok) => {
                        if (ok) setPermanentlyDeletingGateway(null);
                      },
                    },
                  );
                }}
                confirmLabel={PERMANENT_DELETE_LABEL}
              />
            )}

            <CloneAgentDialog
              agent={cloningGateway}
              onOpenChange={(open) => {
                if (!open) setCloningGateway(null);
              }}
              onCloned={(cloned) => {
                // Land on the clone's Configuration step so it can be renamed
                // straight away.
                router.push(
                  agentEditHref("mcp_gateway", cloned.id, "configuration"),
                );
              }}
            />

            <AgentVersionHistoryDialog
              agentId={history?.id ?? null}
              canModify={!!history?.canModify}
              onOpenChange={(open) => {
                if (!open) setHistory(null);
              }}
            />
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

  // `mutate` with callbacks rather than an awaited `mutateAsync`: the query
  // layer rejects on failure (and toasts), and an unhandled rejection here
  // would take the page down instead.
  const handleDelete = useCallback(() => {
    deleteGateway.mutate(agentId, {
      onSuccess: (result) => {
        if (!result) return;
        toast.success("MCP Gateway deleted successfully");
        onOpenChange(false);
      },
    });
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
