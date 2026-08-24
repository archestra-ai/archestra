"use client";

import { type archestraApiTypes, E2eTestId } from "@archestra/shared";
import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import { ChevronDown, ChevronUp, Pencil, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
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
import { BulkVisibilityDialog } from "@/components/bulk-visibility-dialog";
import { CloneAgentDialog } from "@/components/clone-agent-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { ExternalDocsLink } from "@/components/external-docs-link";
import { FilterBar, filterSearchClass } from "@/components/filter-bar";
import { LoadingState, LoadingWrapper } from "@/components/loading";
import { PageLayout } from "@/components/page-layout";
import { PERMANENT_DELETE_LABEL } from "@/components/permanent-delete";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
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
import { BulkActionsBar } from "@/components/ui/bulk-actions-bar";
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
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useMyTeams } from "@/lib/teams/team.query";
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
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function LlmProxies({ initialData }: { initialData?: LlmProxiesInitialData }) {
  const docsUrl = getFrontendDocsUrl("platform-llm-proxy");
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
    | "team"
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
  const { data: canDeleteAgents } = useHasPermissions({ agent: ["delete"] });
  const proxyAgentTypes: Array<"llm_proxy" | "profile"> =
    isDeletedView && !canDeleteAgents
      ? ["llm_proxy"]
      : ["llm_proxy", "profile"];

  /** Everything narrowing the table, shared by the page query and
      the "all matching" walk behind it. */
  const listFilters = {
    sortBy,
    sortDirection,
    name: nameFilter || undefined,
    agentTypes: proxyAgentTypes,
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

  const { data: isAdmin } = useHasPermissions({ llmProxy: ["admin"] });
  const { data: isTeamAdmin } = useHasPermissions({
    llmProxy: ["team-admin"],
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

  type ProxyData = archestraApiTypes.GetAgentsResponses["200"]["data"][number];

  // Create/edit used to be dialogs on this page, opened from `?create=true`
  // and `?edit=<id>`; those links still arrive and now land on the routed
  // pages.
  useEffect(() => {
    const redirect = resolveLegacyAgentDialogRedirect(
      "llm_proxy",
      searchParams,
    );
    if (redirect) router.replace(redirect);
  }, [searchParams, router]);
  const [deletingProxyId, setDeletingProxyId] = useState<string | null>(null);
  const [cloningProxy, setCloningProxy] = useState<ProxyData | null>(null);
  // The row's scope check travels with the id: it is computed per row, and the
  // dialog's restore is an update that has to answer to it.
  const [history, setHistory] = useState<{
    id: string;
    canModify: boolean;
  } | null>(null);
  const [permanentlyDeletingProxy, setPermanentlyDeletingProxy] =
    useState<ProxyData | null>(null);
  const restoreProxy = useRestoreProfile();
  const permanentlyDeleteProxy = usePermanentlyDeleteProfile("LLM Proxy");

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
  const { data: allMatching, isFetching: isFetchingAllMatching } =
    useAllMatchingProfiles(listFilters, { enabled: allMatchingSelected });

  const pageSelection = isDeletedView
    ? []
    : agents.filter((row) => rowSelection[row.id]);
  const selectedProxies =
    allMatchingSelected && allMatching ? allMatching : pageSelection;

  const renderProxyActions = (agent: ProxyData) => {
    const isLegacy = agent.agentType === "profile";
    const canModify = computeCanModifyAgent({
      agent,
      isAdmin: isLegacy ? !!isLegacyAdmin : !!isAdmin,
      isTeamAdmin: isLegacy ? !!isLegacyTeamAdmin : !!isTeamAdmin,
      currentUserId,
      userTeamIds: userTeamIdSet,
    });
    return (
      <LlmProxyActions
        agent={agent}
        canModify={canModify}
        onEdit={(target) => router.push(agentEditHref("llm_proxy", target.id))}
        onDelete={setDeletingProxyId}
        onRestore={(agentId) => {
          restoreProxy.mutate(agentId, {
            onSuccess: (data) => {
              if (!data) return;
              toast.success("LLM Proxy restored successfully");
            },
          });
        }}
        onPermanentlyDelete={setPermanentlyDeletingProxy}
        onClone={setCloningProxy}
        onHistory={(id, historyCanModify) =>
          setHistory({ id, canModify: historyCanModify })
        }
      />
    );
  };

  const columns: ColumnDef<ProxyData>[] = [
    // A deleted row can only be restored or purged, neither of which this
    // selection drives, so the trash view keeps its rows unselectable.
    ...(isDeletedView
      ? []
      : [
          createSelectColumn<ProxyData>({
            rowLabel: (row) => `Select ${row.name}`,
            allLabel: "Select all proxies on this page",
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
        return (
          <AgentNameCell
            name={agent.name}
            // A trashed proxy has no detail page: `GET /api/agents/:id`
            // filters deleted rows, so the link would land on "not found".
            href={
              agent.deletedAt
                ? undefined
                : agentDetailHref("llm_proxy", agent.id)
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
      cell: ({ row }) => (
        // The whole cell, so a disabled action's tooltip wrapper cannot let
        // the click through to the row either.
        <RowClickShield>{renderProxyActions(row.original)}</RowClickShield>
      ),
    },
  ];

  return (
    <LoadingWrapper
      isPending={showLoading}
      loadingFallback={
        <LoadingState label="Loading LLM proxies…" variant="viewport" />
      }
    >
      <PageLayout
        title="LLM Proxies"
        description={
          <p className="text-sm text-muted-foreground">
            LLM Proxies provide security, observability, and cost management for
            your LLM API calls.
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
            permissions={{ llmProxy: ["create"] }}
            onClick={() => router.push(agentNewHref("llm_proxy"))}
            data-testid={E2eTestId.CreateAgentButton}
          >
            <Plus className="h-4 w-4" />
            Create LLM Proxy
          </PermissionButton>
        }
      >
        <TableCardView storageKey="archestra-llm-proxies-view">
          <div>
            <div>
              <div className="mb-6 flex flex-col gap-2">
                <FilterBar
                  className="mb-0"
                  actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
                >
                  <SearchInput
                    objectNamePlural="proxies"
                    searchFields={["name"]}
                    paramName="name"
                    className={filterSearchClass}
                  />
                  <ResourceScopeFilter
                    showLabels
                    ownerLabelPlural="LLM proxies"
                    adminPermission={{ llmProxy: ["admin"] }}
                  />
                  <ResourceDeletedStatusFilter
                    deletePermission={{ llmProxy: ["delete"] }}
                  />
                </FilterBar>
                {!canReadTeams && (
                  <PermissionRequirementHint
                    message="Team-based filters and sharing details are unavailable without"
                    permissions={[{ resource: "team", action: "read" }]}
                  />
                )}
                <ActiveFilterBadges adminPermission={{ llmProxy: ["admin"] }} />
              </div>

              <div data-testid={E2eTestId.AgentsTable}>
                <BulkActionsBar
                  count={selectedProxies.length}
                  noun="proxy"
                  plural="proxies"
                  onClear={clearSelection}
                  busy={bulkDelete.isPending || isFetchingAllMatching}
                  selectAllMatching={{
                    total: pagination?.total ?? 0,
                    pageFullySelected:
                      agents.length > 0 &&
                      pageSelection.length === agents.length,
                    active: allMatchingSelected,
                    onSelectAll: () => setEscalatedFor(filterSignature),
                    matchDescription: nameFilter
                      ? "match this search query"
                      : "match the current filters",
                  }}
                  className="mb-3"
                >
                  <PermissionButton
                    permissions={{ agent: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkVisibilityOpen(true)}
                  >
                    <Pencil className="h-4 w-4" />
                    <span>Edit visibility</span>
                  </PermissionButton>
                  <PermissionButton
                    permissions={{ agent: ["delete"] }}
                    variant="destructive"
                    size="sm"
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete</span>
                  </PermissionButton>
                </BulkActionsBar>

                <TableCardViewContent
                  forceTable={isDeletedView}
                  cards={
                    <TableCardList
                      itemCount={agents.length}
                      hasActiveFilters={Boolean(
                        nameFilter ||
                          scopeFilter.hasActiveScopeFilters ||
                          labelsFromUrl,
                      )}
                      filteredEmptyMessage="No LLM proxies match your filters. Try adjusting your search."
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
                              fallbackType="llm_proxy"
                            />
                          }
                          title={
                            <Link href={agentDetailHref("llm_proxy", agent.id)}>
                              {agent.name}
                            </Link>
                          }
                          description={agent.description}
                          actions={renderProxyActions(agent)}
                          selected={!!rowSelection[agent.id]}
                          onSelectedChange={(selected) => {
                            const next = { ...rowSelection };
                            if (selected) next[agent.id] = true;
                            else delete next[agent.id];
                            setRowSelection(next);
                          }}
                          selectionLabel={`Select ${agent.name}`}
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
                            {agent.agentType === "profile" ? (
                              <Badge variant="outline">Profile</Badge>
                            ) : null}
                          </div>
                        </TableCard>
                      ))}
                    </TableCardList>
                  }
                  table={
                    <DataTable
                      columns={columns}
                      data={agents}
                      getRowId={(row) => row.id}
                      rowSelection={rowSelection}
                      onRowSelectionChange={setRowSelection}
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
                                  agentDetailHref("llm_proxy", row.id),
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
                      emptyMessage={
                        isDeletedView
                          ? "No deleted LLM proxies found"
                          : "No LLM proxies found"
                      }
                      filteredEmptyMessage={
                        isDeletedView
                          ? "No deleted LLM proxies found."
                          : "No LLM proxies match your filters. Try adjusting your search."
                      }
                    />
                  }
                />
              </div>

              {bulkVisibilityOpen && (
                <BulkVisibilityDialog
                  items={selectedProxies.map((profile) => ({
                    ...profile,
                    teams: profile.teams ?? [],
                    users: profile.users ?? [],
                  }))}
                  noun="proxy"
                  plural="proxies"
                  open={bulkVisibilityOpen}
                  onOpenChange={setBulkVisibilityOpen}
                  isPending={bulkVisibility.isPending}
                  onApply={async (change) => {
                    const outcome = await bulkVisibility.mutateAsync({
                      profiles: selectedProxies,
                      scope: change.scope,
                      teamIds: change.teamIds,
                      userIds: change.userIds,
                    });
                    reportBulkOutcome({
                      outcome,
                      verb: "Updated",
                      failureVerb: "update",
                      noun: "proxy",
                      plural: "proxies",
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
                  title="Delete proxies"
                  description={`Delete ${selectedProxies.length} ${
                    selectedProxies.length === 1 ? "proxy" : "proxies"
                  }? This cannot be undone.`}
                  isPending={bulkDelete.isPending}
                  onConfirm={() => {
                    bulkDelete.mutate(selectedProxies, {
                      onSuccess: (outcome) => {
                        reportBulkOutcome({
                          outcome,
                          verb: "Deleted",
                          failureVerb: "delete",
                          noun: "proxy",
                          plural: "proxies",
                        });
                        setBulkDeleteOpen(false);
                        // Rows that failed stay ticked so the selection can be
                        // retried rather than rebuilt.
                        if (outcome.failed.length === 0) clearSelection();
                      },
                    });
                  }}
                  confirmLabel="Delete proxies"
                  pendingLabel="Deleting..."
                />
              )}

              {deletingProxyId && (
                <DeleteProxyDialog
                  agentId={deletingProxyId}
                  open={!!deletingProxyId}
                  onOpenChange={(open) => !open && setDeletingProxyId(null)}
                />
              )}

              {permanentlyDeletingProxy && (
                <DeleteConfirmDialog
                  open={!!permanentlyDeletingProxy}
                  onOpenChange={(open) =>
                    !open && setPermanentlyDeletingProxy(null)
                  }
                  title="Delete LLM Proxy permanently"
                  description={AGENT_PAGE_CONFIGS.llm_proxy.permanentDeleteDescription(
                    permanentlyDeletingProxy.name,
                  )}
                  isPending={permanentlyDeleteProxy.isPending}
                  onConfirm={() => {
                    permanentlyDeleteProxy.mutate(permanentlyDeletingProxy.id, {
                      onSuccess: (ok) => {
                        if (ok) setPermanentlyDeletingProxy(null);
                      },
                    });
                  }}
                  confirmLabel={PERMANENT_DELETE_LABEL}
                />
              )}

              <CloneAgentDialog
                agent={cloningProxy}
                onOpenChange={(open) => {
                  if (!open) setCloningProxy(null);
                }}
                onCloned={(cloned) => {
                  // Land on the clone's Configuration step so it can be renamed
                  // straight away.
                  router.push(
                    agentEditHref("llm_proxy", cloned.id, "configuration"),
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
    </LoadingWrapper>
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

  // `mutate` with callbacks rather than an awaited `mutateAsync`: the query
  // layer rejects on failure (and toasts), and an unhandled rejection here
  // would take the page down instead.
  const handleDelete = useCallback(() => {
    deleteProxy.mutate(agentId, {
      onSuccess: (result) => {
        if (!result) return;
        toast.success("LLM Proxy deleted successfully");
        onOpenChange(false);
      },
    });
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
