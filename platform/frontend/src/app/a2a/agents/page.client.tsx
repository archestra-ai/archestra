"use client";

import type {
  ColumnDef,
  RowSelectionState,
  SortingState,
} from "@tanstack/react-table";
import {
  Activity,
  Bot,
  ChevronDown,
  ChevronUp,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { A2aRemoteAgentActions } from "@/components/a2a-remote-agent-actions";
import { A2aBulkVisibilityDialog } from "@/components/a2a-remote-agent-bulk-visibility-dialog";
import { AgentIcon } from "@/components/agent-icon";
import {
  openRowOnPlainClick,
  RowClickShield,
} from "@/components/agent-pages/row-click-shield";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { PermissionRequirementHint } from "@/components/permission-requirement-hint";
import { QueryLoadError } from "@/components/query-load-error";
import {
  ActiveFilterBadges,
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
import { DEFAULT_SORT_BY, DEFAULT_SORT_DIRECTION } from "@/consts";
import {
  type A2aRemoteAgent,
  useA2aRemoteAgentRuns,
  useA2aRemoteAgents,
  useDeleteA2aRemoteAgent,
} from "@/lib/a2a-remote-agents.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome, runBulkAction } from "@/lib/bulk-action";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";

type A2aSortBy = "name" | "createdAt" | "updatedAt";

function SortIcon({ isSorted }: { isSorted: false | "asc" | "desc" }) {
  const upArrow = <ChevronUp className="h-3 w-3" />;
  const downArrow = <ChevronDown className="h-3 w-3" />;
  if (isSorted === "asc") return upArrow;
  if (isSorted === "desc") return downArrow;
  return (
    <div className="text-muted-foreground flex flex-col items-center">
      {upArrow}
      <span className="mt-[-4px]">{downArrow}</span>
    </div>
  );
}

function isA2aSortBy(value: string | null): value is A2aSortBy {
  return value === "name" || value === "createdAt" || value === "updatedAt";
}

function compareRemoteAgents(
  left: A2aRemoteAgent,
  right: A2aRemoteAgent,
  sorting: SortingState,
) {
  const activeSort = sorting[0];
  if (!activeSort) return 0;

  const leftValue =
    activeSort.id === "name"
      ? left.name
      : activeSort.id === "updatedAt"
        ? left.updatedAt
        : left.createdAt;
  const rightValue =
    activeSort.id === "name"
      ? right.name
      : activeSort.id === "updatedAt"
        ? right.updatedAt
        : right.createdAt;
  const result = leftValue.localeCompare(rightValue);
  if (result !== 0) return activeSort.desc ? -result : result;
  return left.name.localeCompare(right.name);
}

export default function OutboundA2aAgentsPage() {
  const {
    searchParams,
    pageIndex,
    pageSize,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();
  const router = useRouter();
  const query = useA2aRemoteAgents();
  const { data: canManage } = useHasPermissions({
    agentSettings: ["update"],
  });
  const { data: canReadTeams } = useHasPermissions({ team: ["read"] });
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const scopeFilter = useScopeFilterParams();
  const [deleteTarget, setDeleteTarget] = useState<A2aRemoteAgent | null>(null);
  const deleteMutation = useDeleteA2aRemoteAgent();
  const bulkDeleteMutation = useDeleteA2aRemoteAgent({ notify: false });
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const remoteAgents = query.data ?? [];

  const nameFilter = searchParams.get("name") || "";
  const sortByFromUrl = searchParams.get("sortBy");
  const sortDirectionFromUrl = searchParams.get("sortDirection");
  const sortBy: A2aSortBy = isA2aSortBy(sortByFromUrl)
    ? sortByFromUrl
    : isA2aSortBy(DEFAULT_SORT_BY)
      ? DEFAULT_SORT_BY
      : "createdAt";
  const sortDirection =
    sortDirectionFromUrl === "asc" || sortDirectionFromUrl === "desc"
      ? sortDirectionFromUrl
      : DEFAULT_SORT_DIRECTION;
  const [sorting, setSorting] = useState<SortingState>([
    { id: sortBy, desc: sortDirection === "desc" },
  ]);

  useEffect(() => {
    setSorting([{ id: sortBy, desc: sortDirection === "desc" }]);
  }, [sortBy, sortDirection]);

  const handleSortingChange = useCallback(
    (updater: SortingState | ((old: SortingState) => SortingState)) => {
      const nextSorting =
        typeof updater === "function" ? updater(sorting) : updater;
      setSorting(nextSorting);

      if (nextSorting.length > 0 && isA2aSortBy(nextSorting[0].id)) {
        updateQueryParams({
          page: "1",
          sortBy: nextSorting[0].id,
          sortDirection: nextSorting[0].desc ? "desc" : "asc",
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

  const filteredAgents = useMemo(() => {
    const normalizedFilter = nameFilter.trim().toLocaleLowerCase();
    return remoteAgents
      .filter((agent) => {
        if (
          normalizedFilter &&
          !agent.name.toLocaleLowerCase().includes(normalizedFilter)
        ) {
          return false;
        }
        if (scopeFilter.scope && agent.scope !== scopeFilter.scope)
          return false;
        if (
          scopeFilter.teamIds?.length &&
          !agent.teams.some((team) => scopeFilter.teamIds?.includes(team.id))
        ) {
          return false;
        }
        if (
          scopeFilter.authorIds?.length &&
          (!agent.authorId || !scopeFilter.authorIds.includes(agent.authorId))
        ) {
          return false;
        }
        if (
          scopeFilter.excludeAuthorIds?.length &&
          agent.authorId &&
          scopeFilter.excludeAuthorIds.includes(agent.authorId)
        ) {
          return false;
        }
        if (
          scopeFilter.excludeOtherPersonal &&
          agent.scope === "personal" &&
          currentUserId &&
          agent.authorId !== currentUserId
        ) {
          return false;
        }
        return true;
      })
      .sort((left, right) => compareRemoteAgents(left, right, sorting));
  }, [currentUserId, nameFilter, remoteAgents, scopeFilter, sorting]);

  const totalPages = Math.max(Math.ceil(filteredAgents.length / pageSize), 1);
  useEffect(() => {
    if (pageIndex > 0 && pageIndex >= totalPages) {
      setPagination({ pageIndex: totalPages - 1, pageSize });
    }
  }, [pageIndex, pageSize, setPagination, totalPages]);

  const visibleAgents = filteredAgents.slice(
    pageIndex * pageSize,
    (pageIndex + 1) * pageSize,
  );
  const cardSelection = useBulkCardSelection({
    rows: visibleAgents,
    getRowId: (agent) => agent.id,
    rowSelection,
    setRowSelection,
  });
  const selectedRemoteAgents = visibleAgents.filter(
    (agent) => rowSelection[agent.id],
  );
  const clearSelection = () => setRowSelection({});

  const handlePaginationChange = useCallback(
    (pagination: { pageIndex: number; pageSize: number }) => {
      setPagination(pagination);
    },
    [setPagination],
  );

  const hasActiveFilters = !!(nameFilter || scopeFilter.hasActiveScopeFilters);
  const clearFilters = useCallback(() => {
    updateQueryParams({
      page: "1",
      name: null,
      scope: null,
      teamIds: null,
      authorIds: null,
      excludeAuthorIds: null,
    });
  }, [updateQueryParams]);

  const openAgent = useCallback(
    (agent: A2aRemoteAgent) => router.push(`/a2a/agents/${agent.id}`),
    [router],
  );
  const renderActions = useCallback(
    (agent: A2aRemoteAgent) => (
      <A2aRemoteAgentActions
        agent={agent}
        canManage={!!canManage}
        onOpen={() => openAgent(agent)}
        onDelete={() => setDeleteTarget(agent)}
      />
    ),
    [canManage, openAgent],
  );

  const columns = useMemo<ColumnDef<A2aRemoteAgent>[]>(
    () => [
      ...(canManage
        ? [
            createSelectColumn<A2aRemoteAgent>({
              rowLabel: (agent) => `Select ${agent.name}`,
              allLabel: "Select all external A2A agents on this page",
            }),
          ]
        : []),
      {
        id: "icon",
        size: 40,
        enableSorting: false,
        header: "",
        cell: () => (
          <div className="flex items-center justify-center">
            <AgentIcon size={20} />
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
        cell: ({ row }) => (
          <RowClickShield>
            <div className="min-w-0">
              <Link
                href={`/a2a/agents/${row.original.id}`}
                className="truncate font-medium"
              >
                {row.original.name}
              </Link>
              <div className="truncate text-xs text-muted-foreground">
                {row.original.description || "External A2A agent"}
              </div>
            </div>
          </RowClickShield>
        ),
      },
      {
        id: "visibility",
        header: "Accessible to",
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
        id: "status",
        header: "Status",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge
            variant={row.original.connection.enabled ? "default" : "secondary"}
          >
            {row.original.connection.enabled ? "Enabled" : "Disabled"}
          </Badge>
        ),
      },
      ...(canManage
        ? [
            {
              id: "activity",
              header: "Recent activity",
              enableSorting: false,
              cell: ({ row }) => <RecentRun remoteAgentId={row.original.id} />,
            } satisfies ColumnDef<A2aRemoteAgent>,
          ]
        : []),
      {
        id: "actions",
        header: "Actions",
        enableHiding: false,
        size: 120,
        cell: ({ row }) => (
          <RowClickShield>{renderActions(row.original)}</RowClickShield>
        ),
      },
    ],
    [canManage, currentUserId, renderActions],
  );

  const showLoading = query.isPending && remoteAgents.length === 0;
  const pagination = {
    pageIndex,
    pageSize,
    total: filteredAgents.length,
  };

  const handleBulkDelete = async () => {
    const outcome = await runBulkAction({
      items: selectedRemoteAgents,
      run: (agent) => bulkDeleteMutation.mutateAsync(agent.id),
      describe: (agent) => agent.name,
    });
    reportBulkOutcome({
      outcome,
      verb: "Deleted",
      failureVerb: "delete",
      noun: "external A2A agent",
    });
    setBulkDeleteOpen(false);
    if (outcome.failed.length === 0) clearSelection();
  };

  return (
    <PageLayout
      title="External Agents"
      description="Connect Agent2Agent-compatible systems, then assign them from an agent's Subagents section."
      actionButton={
        canManage ? (
          <Button onClick={() => router.push("/a2a/agents/new")}>
            <Plus className="h-4 w-4" />
            <span>Connect agent</span>
          </Button>
        ) : undefined
      }
    >
      {query.isLoadingError ? (
        <QueryLoadError
          title="External A2A agents could not be loaded"
          description="Retry the connection to load configured external agents."
          onRetry={() => query.refetch()}
        />
      ) : (
        <TableCardView storageKey="archestra-a2a-agents-view">
          <CollectionFilters>
            <FilterBar leading actions={<TableCardViewToggle />}>
              <SearchInput
                isLoading={query.isFetching}
                objectNamePlural="external A2A agents"
                searchFields={["name"]}
                paramName="name"
                className={filterSearchClass}
              />
              <ResourceScopeFilter
                ownerLabelPlural="external A2A agents"
                allLabel="All visibilities"
                adminPermission={{ agentSettings: ["update"] }}
              />
            </FilterBar>
            {!canReadTeams ? (
              <PermissionRequirementHint
                message="Team-based filters and sharing details are unavailable without"
                permissions={[{ resource: "team", action: "read" }]}
              />
            ) : null}
            <ActiveFilterBadges
              adminPermission={{ agentSettings: ["update"] }}
            />
          </CollectionFilters>

          <BulkActions
            count={selectedRemoteAgents.length}
            noun="external A2A agent"
            onClear={clearSelection}
            busy={bulkDeleteMutation.isPending}
          >
            {canManage ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setBulkVisibilityOpen(true)}
                >
                  <Pencil className="h-4 w-4" />
                  <span>Edit visibility</span>
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setBulkDeleteOpen(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  <span>Delete</span>
                </Button>
              </>
            ) : null}
          </BulkActions>

          <TableCardViewContent
            cards={
              <TableCardList
                itemCount={visibleAgents.length}
                isLoading={showLoading}
                emptyIcon={Bot}
                emptyMessage="No external A2A agents connected"
                emptyDescription="Start with a well-known Agent Card URL or paste a card manually."
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage="No external A2A agents match your filters"
                onClearFilters={clearFilters}
                pagination={pagination}
                onPaginationChange={handlePaginationChange}
              >
                {visibleAgents.map((agent) => (
                  <TableCard
                    key={agent.id}
                    testId={`a2a-remote-agent-card-${agent.id}`}
                    icon={<AgentIcon size={20} />}
                    title={agent.name}
                    description={agent.description || "External A2A agent"}
                    actions={renderActions(agent)}
                    onNavigate={() => openAgent(agent)}
                    footer={
                      canManage ? (
                        <RecentRun remoteAgentId={agent.id} />
                      ) : undefined
                    }
                    {...(canManage ? cardSelection(agent) : {})}
                    selectionLabel={`Select ${agent.name}`}
                  >
                    <div className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        <ResourceVisibilityBadge
                          scope={agent.scope}
                          teams={agent.teams}
                          users={agent.users}
                          authorId={agent.authorId}
                          authorName={agent.authorName}
                          currentUserId={currentUserId}
                          showSelfAsMe
                          compact
                        />
                        <Badge variant="secondary">A2A 1.x</Badge>
                        <Badge variant="outline">
                          {agent.connection.selectedInterface.protocolBinding}
                        </Badge>
                        <Badge
                          variant={
                            agent.connection.enabled ? "default" : "secondary"
                          }
                        >
                          {agent.connection.enabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </div>
                      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                        <dt className="text-muted-foreground">Discovery</dt>
                        <dd className="truncate">
                          {agent.discoveryMode.replaceAll("_", " ")}
                        </dd>
                        <dt className="text-muted-foreground">
                          Authentication
                        </dt>
                        <dd>
                          {agent.connection.authType.replaceAll("_", " ")}
                        </dd>
                        <dt className="text-muted-foreground">Endpoint</dt>
                        <dd
                          className="truncate"
                          title={agent.connection.selectedInterface.url}
                        >
                          {agent.connection.selectedInterface.url}
                        </dd>
                      </dl>
                    </div>
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                data={visibleAgents}
                isLoading={showLoading}
                getRowId={(agent) => agent.id}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                hideSelectedCount
                sorting={sorting}
                onSortingChange={handleSortingChange}
                manualSorting
                manualPagination
                pagination={pagination}
                onPaginationChange={handlePaginationChange}
                onRowClick={(row, event) =>
                  openRowOnPlainClick(event, () => openAgent(row))
                }
                emptyIcon={Bot}
                emptyMessage="No external A2A agents connected"
                emptyDescription="Start with a well-known Agent Card URL or paste a card manually."
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage="No external A2A agents match your filters"
                onClearFilters={clearFilters}
              />
            }
          />
        </TableCardView>
      )}

      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Remove external A2A agent?"
        description={
          deleteTarget
            ? `This removes ${deleteTarget.name} and its stored connection credential.`
            : ""
        }
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deleteTarget) return;
          deleteMutation.mutate(deleteTarget.id, {
            onSuccess: () => setDeleteTarget(null),
          });
        }}
      />
      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete external A2A agents"
        description={`Delete ${selectedRemoteAgents.length} ${
          selectedRemoteAgents.length === 1
            ? "external A2A agent"
            : "external A2A agents"
        }? This cannot be undone.`}
        isPending={bulkDeleteMutation.isPending}
        onConfirm={() => void handleBulkDelete()}
        confirmLabel="Delete external A2A agents"
        pendingLabel="Deleting..."
      />
      {bulkVisibilityOpen ? (
        <A2aBulkVisibilityDialog
          agents={selectedRemoteAgents}
          open={bulkVisibilityOpen}
          onOpenChange={setBulkVisibilityOpen}
          onComplete={clearSelection}
        />
      ) : null}
    </PageLayout>
  );
}

function RecentRun({ remoteAgentId }: { remoteAgentId: string }) {
  const query = useA2aRemoteAgentRuns(remoteAgentId);
  const run = query.data?.[0];
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Activity className="h-3.5 w-3.5" />
        Recent activity
      </span>
      {query.isPending ? (
        <span className="text-muted-foreground">Loading…</span>
      ) : query.isError ? (
        <span className="text-destructive">Unavailable</span>
      ) : run ? (
        <span title={new Date(run.startedAt).toLocaleString()}>
          {run.state.replaceAll("_", " ")} ·{" "}
          {new Date(run.startedAt).toLocaleDateString()}
        </span>
      ) : (
        <span className="text-muted-foreground">No runs yet</span>
      )}
    </div>
  );
}
