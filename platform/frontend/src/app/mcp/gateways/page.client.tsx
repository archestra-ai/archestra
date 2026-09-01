"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
  Waypoints,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import {
  AgentAccessBadges,
  AgentLastUsedFooter,
} from "@/components/agent-card-meta";
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
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
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
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
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
  useAllMatchingProfiles,
  useBulkDeleteProfiles,
  useBulkUpdateProfileVisibility,
  useDeleteProfile,
  usePermanentlyDeleteProfile,
  useProfilesPaginated,
  useRestoreProfile,
} from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
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

/**
 * What a gateway exposes, in the one column the list has for it.
 *
 * The column used to render `tools.length`, which is a lie for the default
 * configuration: an Auto-mode gateway has no per-tool rows at all, so it
 * showed "0" while exposing the whole catalogue. It is also a counter with no
 * denominator, which the detail-page rules forbid — and the denominator cannot
 * honestly be named here, because the catalogue a gateway reaches depends on
 * its environment's installs and on its own exclusions, and `GET /api/tools`
 * would pull every tool's JSON schema onto a list page to find out. So the set
 * is named instead of counted, and the list itself is one hover away, which is
 * what the rules say to do when the denominator is unavailable.
 */
function ExposedSetCell({
  exposesEverything,
  everythingLabel,
  names,
  noun,
}: {
  exposesEverything: boolean;
  /** What "everything" is called here — "All tools", "All subagents". */
  everythingLabel: string;
  names: string[];
  noun: string;
}) {
  if (exposesEverything) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="text-sm">{everythingLabel}</span>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          Every {noun} this gateway's environment offers, minus its exclusions.
          The set grows as servers are installed.
        </TooltipContent>
      </Tooltip>
    );
  }

  if (names.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-sm">{names.length} selected</span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{names.join(", ")}</TooltipContent>
    </Tooltip>
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
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteProfiles();
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const bulkVisibility = useBulkUpdateProfileVisibility();
  const clearSelection = useCallback(() => {
    setRowSelection({});
    setEscalatedFor(null);
  }, []);

  const sortBy = sortByFromUrl || DEFAULT_SORT_BY;
  const sortDirection = sortDirectionFromUrl || DEFAULT_SORT_DIRECTION;
  const { data: canReadAgents } = useHasPermissions({ agent: ["read"] });
  const { data: canDeleteAgents } = useHasPermissions({ agent: ["delete"] });
  const gatewayAgentTypes: Array<"mcp_gateway" | "profile"> = canReadAgents
    ? isDeletedView && !canDeleteAgents
      ? ["mcp_gateway"]
      : ["mcp_gateway", "profile"]
    : ["mcp_gateway"];

  /** Everything narrowing the table, shared by the page query and
      the "all matching" walk behind it. */
  const listFilters = {
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
  } satisfies Omit<
    NonNullable<archestraApiTypes.GetAgentsData["query"]>,
    "limit" | "offset"
  >;

  const {
    data: agentsResponse,
    isPending,
    isFetching,
    isLoadingError: isGatewaysLoadError,
    refetch: refetchGateways,
  } = useProfilesPaginated({
    limit: pageSize,
    offset,
    initialData: initialData?.agents ?? undefined,
    ...listFilters,
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });

  const { data: userTeams } = useMyTeams({
    enabled: !!canReadTeams,
  });

  const { data: isAdmin } = useHasPermissions({ mcpGateway: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    mcpGateway: ["team-admin"],
  });
  const { data: isLegacyAdmin } = useHasPermissions({ agent: ["admin"] });
  const { data: isLegacyTeamAdmin } = useHasPermissions({
    agent: ["team-admin"],
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
  const showLoading = (isPending || isFetching) && agents.length === 0;
  // Derived from what is on screen rather than read straight out of
  // `rowSelection`: the table is server-paginated, so ids left behind by
  // another page drop out of both the count and the request.
  const filterSignature = JSON.stringify(listFilters);
  const [escalatedFor, setEscalatedFor] = useState<string | null>(null);
  const allMatchingSelected = escalatedFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: agents,
      getRowId: (row) => row.id,
      allMatchingSelected,
      clearEscalation: () => setEscalatedFor(null),
    });
  const cardSelection = useBulkCardSelection({
    rows: agents,
    getRowId: (row) => row.id,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    rangeSelection,
  });
  const { data: allMatching, isFetching: isFetchingAllMatching } =
    useAllMatchingProfiles(listFilters, { enabled: allMatchingSelected });

  const pageSelection = isDeletedView
    ? []
    : agents.filter((row) => effectiveRowSelection[row.id]);
  const selectedGateways =
    allMatchingSelected && allMatching ? allMatching : pageSelection;

  const renderGatewayActions = (agent: GatewayData) => {
    const isLegacy = agent.agentType === "profile";
    const canModify = computeCanModifyAgent({
      agent,
      isAdmin: isLegacy ? !!isLegacyAdmin : !!isAdmin,
      isTeamAdmin: isLegacy ? !!isLegacyTeamAdmin : !!isTeamAdmin,
      currentUserId,
      userTeamIds: userTeamIdSet,
    });
    return (
      <McpGatewayActions
        agent={agent}
        canModify={canModify}
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
    );
  };

  const columns: ColumnDef<GatewayData>[] = [
    // A deleted row can only be restored or purged, neither of which this
    // selection drives, so the trash view keeps its rows unselectable.
    ...(isDeletedView
      ? []
      : [
          createSelectColumn<GatewayData>({
            rowLabel: (row) => `Select ${row.name}`,
            allLabel: "Select all gateways on this page",
          }),
        ]),
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
                      This is a legacy profile entity that behaves as an MCP
                      Gateway
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
      size: 110,
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
      cell: ({ row }) => (
        <ExposedSetCell
          exposesEverything={row.original.accessAllTools}
          everythingLabel="All tools"
          names={row.original.tools
            .filter((tool) => !tool.delegateToAgentId)
            .map((tool) => tool.name)}
          noun="tool"
        />
      ),
    },
    {
      id: "subagentsCount",
      accessorKey: "subagentsCount",
      size: 120,
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
      cell: ({ row }) => (
        <ExposedSetCell
          exposesEverything={row.original.accessAllSubagents}
          everythingLabel="All subagents"
          names={row.original.tools
            .filter((tool) => tool.delegateToAgentId)
            .map((tool) => tool.name)}
          noun="subagent"
        />
      ),
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
      // Pixel-sized so the row's buttons never clip: the actions column keeps
      // its px width while the sized columns scale down to fit.
      size: 140,
      enableHiding: false,
      cell: ({ row }) => (
        // The whole cell, so a disabled action's tooltip wrapper cannot let
        // the click through to the row either.
        <RowClickShield>{renderGatewayActions(row.original)}</RowClickShield>
      ),
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
      <TableCardView storageKey="archestra-mcp-gateways-view">
        <div>
          <div>
            <CollectionFilters>
              <FilterBar
                leading
                actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
              >
                <SearchInput
                  isLoading={isFetching}
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
            </CollectionFilters>

            <div data-testid={E2eTestId.AgentsTable}>
              <BulkActions
                count={selectedGateways.length}
                noun="gateway"
                plural="gateways"
                onClear={clearSelection}
                busy={bulkDelete.isPending || isFetchingAllMatching}
                selectAllMatching={{
                  total: pagination?.total ?? 0,
                  pageFullySelected:
                    agents.length > 0 && pageSelection.length === agents.length,
                  active: allMatchingSelected,
                  onSelectAll: () => setEscalatedFor(filterSignature),
                  matchDescription: nameFilter
                    ? "match this search query"
                    : "match the current filters",
                }}
              >
                <PermissionButton
                  permissions={{ mcpGateway: ["update"] }}
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkVisibilityOpen(true)}
                >
                  <Pencil className="h-4 w-4" />
                  <span>Edit visibility</span>
                </PermissionButton>
                <PermissionButton
                  permissions={{ mcpGateway: ["delete"] }}
                  variant="destructive"
                  size="sm"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete</span>
                </PermissionButton>
              </BulkActions>

              <TableCardViewContent
                forceTable={isDeletedView}
                cards={
                  <TableCardList
                    itemCount={agents.length}
                    isLoading={showLoading}
                    hasActiveFilters={Boolean(
                      nameFilter ||
                        scopeFilter.hasActiveScopeFilters ||
                        labelsFromUrl,
                    )}
                    emptyIcon={Waypoints}
                    filteredEmptyMessage="No MCP gateways match your filters"
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
                    pagination={{
                      pageIndex,
                      pageSize,
                      total: pagination?.total ?? 0,
                    }}
                    onPaginationChange={handlePaginationChange}
                  >
                    {agents.map((agent) => (
                      <TableCard
                        key={agent.id}
                        icon={
                          <AgentIcon
                            icon={agent.icon}
                            size={20}
                            fallbackType="mcp_gateway"
                          />
                        }
                        title={
                          <Link href={agentDetailHref("mcp_gateway", agent.id)}>
                            {agent.name}
                          </Link>
                        }
                        description={agent.description}
                        actions={renderGatewayActions(agent)}
                        onNavigate={
                          isDeletedView
                            ? undefined
                            : () =>
                                router.push(
                                  agentDetailHref("mcp_gateway", agent.id),
                                )
                        }
                        {...cardSelection(agent)}
                        selectionLabel={`Select ${agent.name}`}
                        footer={
                          <AgentLastUsedFooter lastUsedAt={agent.lastUsedAt} />
                        }
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <ResourceVisibilityBadge
                            scope={agent.scope}
                            teams={agent.teams}
                            users={agent.users}
                            authorId={agent.authorId}
                            authorName={agent.authorName}
                            currentUserId={currentUserId}
                            showSelfAsMe
                          />
                          <AgentAccessBadges agent={agent} />
                        </div>
                      </TableCard>
                    ))}
                  </TableCardList>
                }
                table={
                  <DataTable
                    columns={columns}
                    data={agents}
                    isLoading={showLoading}
                    getRowId={(row) => row.id}
                    rowSelection={effectiveRowSelection}
                    onRowSelectionChange={onRowSelectionChange}
                    rangeSelection={rangeSelection}
                    hideSelectedCount
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
                              router.push(
                                agentDetailHref("mcp_gateway", row.id),
                              ),
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
                    emptyIcon={Waypoints}
                    emptyMessage={
                      isDeletedView
                        ? "No deleted MCP gateways found."
                        : "No MCP gateways found"
                    }
                    filteredEmptyMessage={
                      isDeletedView
                        ? "No deleted MCP gateways found."
                        : "No MCP gateways match your filters"
                    }
                  />
                }
              />
            </div>

            {bulkVisibilityOpen && (
              <BulkVisibilityDialog
                items={selectedGateways.map((profile) => ({
                  ...profile,
                  teams: profile.teams ?? [],
                  users: profile.users ?? [],
                }))}
                noun="gateway"
                plural="gateways"
                open={bulkVisibilityOpen}
                onOpenChange={setBulkVisibilityOpen}
                isPending={bulkVisibility.isPending}
                onApply={async (change) => {
                  const outcome = await bulkVisibility.mutateAsync({
                    profiles: selectedGateways,
                    scope: change.scope,
                    teamIds: change.teamIds,
                    userIds: change.userIds,
                  });
                  reportBulkOutcome({
                    outcome,
                    verb: "Updated",
                    failureVerb: "update",
                    noun: "gateway",
                    plural: "gateways",
                  });
                  if (outcome.succeeded.length === 0) return false;
                  if (outcome.failed.length === 0) clearSelection();
                  return true;
                }}
              />
            )}

            {bulkDeleteOpen && (
              <DeleteConfirmDialog
                open={bulkDeleteOpen}
                onOpenChange={setBulkDeleteOpen}
                title="Delete gateways"
                description={`Delete ${selectedGateways.length} ${
                  selectedGateways.length === 1 ? "gateway" : "gateways"
                }? This cannot be undone.`}
                isPending={bulkDelete.isPending}
                onConfirm={() => {
                  bulkDelete.mutate(selectedGateways, {
                    onSuccess: (outcome) => {
                      reportBulkOutcome({
                        outcome,
                        verb: "Deleted",
                        failureVerb: "delete",
                        noun: "gateway",
                        plural: "gateways",
                      });
                      setBulkDeleteOpen(false);
                      // Rows that failed stay ticked so the selection can be
                      // retried rather than rebuilt.
                      if (outcome.failed.length === 0) clearSelection();
                    },
                  });
                }}
                confirmLabel="Delete gateways"
                pendingLabel="Deleting..."
              />
            )}

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
      </TableCardView>
    </PageLayout>
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
