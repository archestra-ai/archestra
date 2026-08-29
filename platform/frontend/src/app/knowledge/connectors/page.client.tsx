"use client";

import {
  type archestraApiTypes,
  CONNECTOR_TYPE_LABELS,
  type ConnectorType,
} from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { ArchiveRestore, Database, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { BulkConnectorVisibilityDialog } from "@/app/knowledge/connectors/_parts/bulk-connector-visibility-dialog";
import { ConnectorAccessBadge } from "@/app/knowledge/connectors/_parts/connector-access-badge";
import { GoogleDriveOAuthResultToast } from "@/app/knowledge/connectors/_parts/gdrive-connection-card";
import { ConnectorTypeIcon } from "@/app/knowledge/knowledge-bases/_parts/connector-icons";
import { ConnectorStatusCell } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { CreateConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/create-connector-dialog";
import { EditConnectorDialog } from "@/app/knowledge/knowledge-bases/_parts/edit-connector-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import {
  PERMANENT_DELETE_LABEL,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceDeletedStatusFilter } from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { TableRowActions } from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useFeature } from "@/lib/config/config.query";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import { useKnowledgeConnectorCatalog } from "@/lib/integration-overrides";
import {
  useAllMatchingConnectors,
  useBulkDeleteConnectors,
  useBulkUpdateConnectorVisibility,
  useConnector,
  useConnectorsPaginated,
  useDeleteConnector,
  usePermanentlyDeleteConnector,
  useRestoreConnector,
} from "@/lib/knowledge/connector.query";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { formatCronSchedule } from "@/lib/utils/format-cron";

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

const CONNECTOR_TYPE_OPTIONS = [
  "jira",
  "confluence",
  "github",
  "gitlab",
  "servicenow",
  "perforce",
  "mfiles",
  "web_crawler",
] as ConnectorType[];

export default function ConnectorsPage() {
  return (
    <div className="w-full h-full">
      <GoogleDriveOAuthResultToast />
      <ErrorBoundary>
        <ConnectorsList />
      </ErrorBoundary>
    </div>
  );
}

function ConnectorsList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const search = searchParams.get("search") || "";
  const connectorTypeFilter = searchParams.get("connectorType") || "all";
  // M-Files is in beta: deployments that haven't opted in never see the type.
  const mfilesEnabled = useFeature("kbMfilesConnectorEnabled") ?? false;
  const connectorCatalog = useKnowledgeConnectorCatalog();
  const connectorTypeOptions = CONNECTOR_TYPE_OPTIONS.filter(
    (type) =>
      (type !== "mfiles" || mfilesEnabled) && !connectorCatalog.isHidden(type),
  );
  // The trash view; the backend serves deleted connectors to manage-deleted
  // holders only, and the status filter itself is gated the same way.
  const isDeletedView = searchParams.get("status") === "deleted";

  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const {
    data: connectors,
    isPending,
    isFetching,
    isLoadingError: isConnectorsLoadError,
    refetch: refetchConnectors,
  } = useConnectorsPaginated({
    limit: pageSize,
    offset,
    search: search || undefined,
    connectorType:
      connectorTypeFilter === "all"
        ? undefined
        : (connectorTypeFilter as NonNullable<
            archestraApiTypes.GetConnectorsData["query"]
          >["connectorType"]),
    status: isDeletedView ? "deleted" : undefined,
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const editIdFromUrl = searchParams.get("edit");
  const { data: connectorFromUrl } = useConnector(editIdFromUrl ?? undefined);
  const {
    entity: editingConnector,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<
    ConnectorItem | archestraApiTypes.GetConnectorResponses["200"]
  >({
    paramName: "edit",
    entityFromUrl: connectorFromUrl ?? null,
  });
  const [deletingConnectorId, setDeletingConnectorId] = useState<string | null>(
    null,
  );
  const [permanentlyDeletingConnector, setPermanentlyDeletingConnector] =
    useState<ConnectorItem | null>(null);
  const restoreConnector = useRestoreConnector();
  const permanentlyDeleteConnector = usePermanentlyDeleteConnector();
  // Resolved once here rather than inside a cell renderer, as the shared
  // permanent-delete action requires.
  const admin = useIsGlobalAdmin();

  const items = connectors?.data ?? [];
  const pagination = connectors?.pagination;

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectAllMatchingFor, setSelectAllMatchingFor] = useState<
    string | null
  >(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkVisibilityOpen, setBulkVisibilityOpen] = useState(false);
  const bulkDelete = useBulkDeleteConnectors();
  const bulkVisibility = useBulkUpdateConnectorVisibility();

  // Changing a filter invalidates an escalation rather than silently
  // re-pointing "all N" at a different N.
  const filterSignature = `${search}|${connectorTypeFilter}|${isDeletedView}`;
  const allMatchingActive = selectAllMatchingFor === filterSignature;
  const { effectiveRowSelection, onRowSelectionChange, rangeSelection } =
    useControlledRowSelection({
      rowSelection,
      setRowSelection,
      rows: items,
      getRowId: (row) => row.id,
      allMatchingSelected: allMatchingActive,
      clearEscalation: () => setSelectAllMatchingFor(null),
    });
  const cardSelection = useBulkCardSelection({
    rows: items,
    getRowId: (connector) => connector.id,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    rangeSelection,
  });
  const { data: allMatching, isFetching: isFetchingAllMatching } =
    useAllMatchingConnectors(
      {
        search: search || undefined,
        connectorType:
          connectorTypeFilter === "all"
            ? undefined
            : (connectorTypeFilter as NonNullable<
                archestraApiTypes.GetConnectorsData["query"]
              >["connectorType"]),
        status: isDeletedView ? "deleted" : undefined,
      },
      { enabled: allMatchingActive },
    );

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectAllMatchingFor(null);
  }, []);

  // The deleted view has its own lifecycle actions (restore, purge), so bulk
  // editing is offered only over live connectors.
  const pageSelection = isDeletedView
    ? []
    : items.filter((connector) => effectiveRowSelection[connector.id]);
  const selectedConnectors =
    allMatchingActive && allMatching ? allMatching : pageSelection;
  const hasActiveFilters =
    !!search || connectorTypeFilter !== "all" || isDeletedView;

  const handlePaginationChange = useCallback(
    (newPagination: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(newPagination.pageIndex + 1));
      params.set("pageSize", String(newPagination.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const handleConnectorTypeChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value === "all") {
        params.delete("connectorType");
      } else {
        params.set("connectorType", value);
      }
      params.set("page", "1");
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname],
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["search", "connectorType", "status"]) {
      params.delete(key);
    }
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  const connectorActions = (connector: ConnectorItem) => (
    <TableRowActions
      itemName={connector.name}
      actions={[
        {
          icon: <Pencil className="h-4 w-4" />,
          label: "Edit connector",
          onClick: () => openEditDialog(connector),
        },
        {
          icon: <Trash2 className="h-4 w-4" />,
          label: "Delete connector",
          variant: "destructive",
          onClick: () => setDeletingConnectorId(connector.id),
        },
      ]}
    />
  );

  const columns: ColumnDef<ConnectorItem>[] = [
    createSelectColumn<ConnectorItem>({
      rowLabel: (connector) => `Select ${connector.name}`,
      allLabel: "Select all connectors on this page",
    }),
    {
      id: "icon",
      size: 40,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <ConnectorTypeIcon
            type={row.original.connectorType}
            className="h-5 w-5"
          />
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Connector",
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium truncate">{row.original.name}</div>
          {row.original.description && (
            <div className="text-xs text-muted-foreground truncate">
              {row.original.description}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => (
        <ConnectorStatusCell
          lastSyncAt={row.original.lastSyncAt}
          lastSyncStatus={row.original.lastSyncStatus}
        />
      ),
    },
    {
      id: "accessibleTo",
      header: "Accessible to",
      cell: ({ row }) => (
        <ConnectorAccessBadge
          visibility={row.original.visibility}
          teamIds={row.original.teamIds}
        />
      ),
    },
    {
      id: "schedule",
      header: "Schedule",
      cell: ({ row }) => {
        return (
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Database className="h-3.5 w-3.5" />
            <span>{formatCronSchedule(row.original.schedule)}</span>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => connectorActions(row.original),
    },
  ];

  // The trash view: soft-deleted connectors, org-wide (the backend serves them
  // to manage-deleted holders only). Rows do not navigate — the detail page
  // would 404 on a deleted id — and the actions collapse to Restore + Delete
  // permanently, matching the agents, skills, and projects trash views. A
  // restored connector comes back disabled (its credential was destroyed at
  // delete) and is re-authenticated through the normal edit flow.
  const deletedColumns: ColumnDef<ConnectorItem>[] = [
    {
      id: "icon",
      size: 40,
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-center">
          <ConnectorTypeIcon
            type={row.original.connectorType}
            className="h-5 w-5"
          />
        </div>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: "Connector",
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="font-medium truncate">{row.original.name}</div>
          {row.original.description && (
            <div className="text-xs text-muted-foreground truncate">
              {row.original.description}
            </div>
          )}
        </div>
      ),
    },
    {
      id: "deleted",
      header: "Deleted",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="text-sm">
          {formatRelativeTimeFromNow(row.original.deletedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.name}
          actions={[
            {
              icon: <ArchiveRestore className="h-4 w-4" />,
              label: "Restore",
              permissions: { knowledgeSource: ["delete"] },
              onClick: () => restoreConnector.mutate(row.original.id),
            },
            permanentDeleteRowAction({
              admin,
              onClick: () => setPermanentlyDeletingConnector(row.original),
            }),
          ]}
        />
      ),
    },
  ];

  return (
    <KnowledgePageLayout
      title="Connectors"
      description="Connectors sync documents from external sources — like Confluence, Jira, GitHub, Google Drive, and websites — into knowledge bases on a schedule, so your agents can search and answer from them."
      createLabel="Create Connector"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending && !connectors}
    >
      <TableCardView storageKey="archestra-connectors-view">
        <div>
          <CollectionFilters>
            <FilterBar
              leading
              actions={!isDeletedView ? <TableCardViewToggle /> : undefined}
            >
              <SearchInput
                paramName="search"
                className={filterSearchClass}
                isLoading={isFetching}
              />
              <Select
                value={connectorTypeFilter}
                onValueChange={handleConnectorTypeChange}
              >
                <SelectTrigger
                  size="sm"
                  aria-label="Filter by connector type"
                  className={filterControlClass({
                    active: connectorTypeFilter !== "all",
                  })}
                >
                  <SelectValue placeholder="Filter by connector type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All connector types</SelectItem>
                  {connectorTypeOptions.map((type) => (
                    <SelectItem key={type} value={type}>
                      <div className="flex items-center gap-2">
                        <ConnectorTypeIcon type={type} className="h-4 w-4" />
                        <span>{CONNECTOR_TYPE_LABELS[type]}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <ResourceDeletedStatusFilter
                deletePermission={{ knowledgeSource: ["delete"] }}
              />
            </FilterBar>
          </CollectionFilters>

          {isConnectorsLoadError ? (
            <QueryLoadError
              title="Couldn't load your connectors"
              onRetry={() => refetchConnectors()}
            />
          ) : (
            <>
              {!isDeletedView && (
                <BulkActions
                  count={selectedConnectors.length}
                  noun="connector"
                  onClear={clearSelection}
                  busy={
                    bulkDelete.isPending ||
                    bulkVisibility.isPending ||
                    isFetchingAllMatching
                  }
                  selectAllMatching={{
                    total: pagination?.total ?? items.length,
                    pageFullySelected:
                      items.length > 0 &&
                      items.every(
                        (connector) => effectiveRowSelection[connector.id],
                      ),
                    active: allMatchingActive,
                    onSelectAll: () => setSelectAllMatchingFor(filterSignature),
                    matchDescription: "match this search",
                  }}
                >
                  <PermissionButton
                    permissions={{ knowledgeSource: ["update"] }}
                    variant="outline"
                    size="sm"
                    onClick={() => setBulkVisibilityOpen(true)}
                  >
                    <span>Edit visibility</span>
                  </PermissionButton>
                  <PermissionButton
                    permissions={{ knowledgeSource: ["delete"] }}
                    variant="destructive"
                    size="sm"
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    <Trash2 className="h-4 w-4" />
                    <span>Delete</span>
                  </PermissionButton>
                </BulkActions>
              )}

              <TableCardViewContent
                forceTable={isDeletedView}
                cards={
                  <TableCardList
                    itemCount={items.length}
                    isLoading={isFetching || isPending}
                    emptyIcon={Database}
                    emptyMessage="No connectors found"
                    hasActiveFilters={hasActiveFilters}
                    filteredEmptyMessage="No connectors match your filters"
                    onClearFilters={clearFilters}
                    pagination={{
                      pageIndex,
                      pageSize,
                      total: pagination?.total ?? 0,
                    }}
                    onPaginationChange={handlePaginationChange}
                  >
                    {items.map((connector) => (
                      <TableCard
                        key={connector.id}
                        icon={
                          <ConnectorTypeIcon
                            type={connector.connectorType}
                            className="h-5 w-5"
                          />
                        }
                        title={
                          <Link href={`/knowledge/connectors/${connector.id}`}>
                            {connector.name}
                          </Link>
                        }
                        onNavigate={() =>
                          router.push(`/knowledge/connectors/${connector.id}`)
                        }
                        description={connector.description}
                        actions={connectorActions(connector)}
                        {...cardSelection(connector)}
                        selectionLabel={`Select ${connector.name}`}
                        footer={
                          <div className="flex items-center justify-between gap-3">
                            <span>
                              {formatCronSchedule(connector.schedule)}
                            </span>
                            <ConnectorStatusCell
                              lastSyncAt={connector.lastSyncAt}
                              lastSyncStatus={connector.lastSyncStatus}
                            />
                          </div>
                        }
                      >
                        <ConnectorAccessBadge
                          visibility={connector.visibility}
                          teamIds={connector.teamIds}
                        />
                      </TableCard>
                    ))}
                  </TableCardList>
                }
                table={
                  <DataTable
                    columns={isDeletedView ? deletedColumns : columns}
                    data={items}
                    getRowId={(row) => row.id}
                    rowSelection={
                      isDeletedView ? undefined : effectiveRowSelection
                    }
                    onRowSelectionChange={
                      isDeletedView ? undefined : onRowSelectionChange
                    }
                    rangeSelection={rangeSelection}
                    // The deleted view always counts as filtered (see
                    // hasActiveFilters), so its empty state is the filtered one below.
                    emptyIcon={Database}
                    emptyMessage="No connectors found"
                    hasActiveFilters={hasActiveFilters}
                    onClearFilters={clearFilters}
                    filteredEmptyMessage={
                      isDeletedView
                        ? "No deleted connectors found."
                        : "No connectors match your filters"
                    }
                    hideSelectedCount
                    manualPagination
                    pagination={{
                      pageIndex,
                      pageSize,
                      total: pagination?.total ?? 0,
                    }}
                    onPaginationChange={handlePaginationChange}
                    isLoading={isFetching || isPending}
                    onRowClick={
                      isDeletedView
                        ? undefined
                        : (row) =>
                            router.push(`/knowledge/connectors/${row.id}`)
                    }
                  />
                }
              />
            </>
          )}

          {bulkDeleteOpen && (
            <DeleteConfirmDialog
              open={bulkDeleteOpen}
              onOpenChange={setBulkDeleteOpen}
              title="Delete connectors"
              description={`Delete ${selectedConnectors.length} ${
                selectedConnectors.length === 1 ? "connector" : "connectors"
              }? Their synced documents stop being searchable, and each one's stored credential is destroyed — a restored connector comes back disabled and re-authenticates.`}
              isPending={bulkDelete.isPending}
              onConfirm={() => {
                bulkDelete.mutate(selectedConnectors, {
                  onSuccess: (outcome) => {
                    reportBulkOutcome({
                      outcome,
                      verb: "Deleted",
                      failureVerb: "delete",
                      noun: "connector",
                    });
                    setBulkDeleteOpen(false);
                    if (outcome.failed.length === 0) clearSelection();
                  },
                });
              }}
              confirmLabel="Delete connectors"
              pendingLabel="Deleting..."
            />
          )}

          {bulkVisibilityOpen && (
            <BulkConnectorVisibilityDialog
              open={bulkVisibilityOpen}
              onOpenChange={setBulkVisibilityOpen}
              count={selectedConnectors.length}
              isPending={bulkVisibility.isPending}
              onApply={async (change) => {
                const outcome = await bulkVisibility.mutateAsync({
                  connectors: selectedConnectors,
                  visibility: change.visibility,
                  teamIds: change.teamIds,
                });
                reportBulkOutcome({
                  outcome,
                  verb: "Updated",
                  failureVerb: "update",
                  noun: "connector",
                });
                if (outcome.succeeded.length === 0) return false;
                if (outcome.failed.length === 0) clearSelection();
                return true;
              }}
            />
          )}

          {permanentlyDeletingConnector && (
            <DeleteConfirmDialog
              open={!!permanentlyDeletingConnector}
              onOpenChange={(open) => {
                if (!open) setPermanentlyDeletingConnector(null);
              }}
              title="Delete connector permanently"
              description={`This destroys "${permanentlyDeletingConnector.name}" along with its synced documents, run history, and access mappings. Nothing recovers them.`}
              isPending={permanentlyDeleteConnector.isPending}
              onConfirm={async () => {
                const ok = await permanentlyDeleteConnector.mutateAsync(
                  permanentlyDeletingConnector.id,
                );
                if (ok) setPermanentlyDeletingConnector(null);
              }}
              confirmLabel={PERMANENT_DELETE_LABEL}
            />
          )}

          <CreateConnectorDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {editingConnector && (
            <EditConnectorDialog
              connector={editingConnector}
              open={!!editingConnector}
              onOpenChange={(open) => !open && closeEditDialog()}
            />
          )}

          {deletingConnectorId && (
            <DeleteConnectorDialog
              connectorId={deletingConnectorId}
              open={!!deletingConnectorId}
              onOpenChange={(open) => !open && setDeletingConnectorId(null)}
            />
          )}
        </div>
      </TableCardView>
    </KnowledgePageLayout>
  );
}

function DeleteConnectorDialog({
  connectorId,
  open,
  onOpenChange,
}: {
  connectorId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteConnector = useDeleteConnector();

  const handleDelete = useCallback(async () => {
    const result = await deleteConnector.mutateAsync(connectorId);
    if (result) {
      onOpenChange(false);
    }
  }, [connectorId, deleteConnector, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Connector"
      description="Are you sure you want to delete this connector? Its stored credential is revoked immediately and syncing stops. An admin can restore it from the Deleted view until it is permanently removed, but a restored connector comes back disabled and must be re-authenticated and re-enabled before it syncs again."
      isPending={deleteConnector.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Connector"
      pendingLabel="Deleting..."
    />
  );
}
