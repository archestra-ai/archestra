"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  Database,
  Link2,
  MessageSquare,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import {
  CollectionFilters,
  FilterBar,
  filterSearchClass,
} from "@/components/filter-bar";
import { LoadingState } from "@/components/loading";
import {
  PERMANENT_DELETE_LABEL,
  permanentDeleteRowAction,
} from "@/components/permanent-delete";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceDeletedStatusFilter } from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import {
  TableCardGrid,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { TablePagination } from "@/components/ui/table-pagination";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import { reportBulkOutcome } from "@/lib/bulk-action";
import {
  type BulkCardSelectionProps,
  useBulkCardSelection,
} from "@/lib/hooks/use-bulk-card-selection";
import { useControlledRowSelection } from "@/lib/hooks/use-bulk-selection";
import { useDialogUrlParam } from "@/lib/hooks/use-dialog-url-param";
import {
  useConnectors as useAllConnectors,
  useAssignConnectorToKnowledgeBases,
  useConnector,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/knowledge/connector.query";
import {
  useAllMatchingKnowledgeBases,
  useBulkDeleteKnowledgeBases,
  useDeleteKnowledgeBase,
  useKnowledgeBase,
  useKnowledgeBasesPaginated,
  usePermanentlyDeleteKnowledgeBase,
  useRestoreKnowledgeBase,
} from "@/lib/knowledge/knowledge-base.query";
import { useIsGlobalAdmin } from "@/lib/organization.query";
import { cn } from "@/lib/utils";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";
import { ConnectorChip } from "./_parts/connector-chip";
import { ConnectorTypeIcon } from "./_parts/connector-icons";
import { CreateConnectorDialog } from "./_parts/create-connector-dialog";
import { CreateKnowledgeBaseDialog } from "./_parts/create-knowledge-base-dialog";
import { EditConnectorDialog } from "./_parts/edit-connector-dialog";
import { EditKnowledgeBaseDialog } from "./_parts/edit-knowledge-base-dialog";
import { KnowledgeBaseCard } from "./_parts/knowledge-base-card";
import { useChatWithKnowledgeBase } from "./_parts/use-chat-with-knowledge-base";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

const KNOWLEDGE_BASES_DESCRIPTION =
  "A knowledge base is a searchable collection of content, grouped from one or more connectors, that your agents can retrieve answers from.";

export default function KnowledgeBasesPage() {
  return (
    <div className="w-full h-full">
      <ErrorBoundary>
        <KnowledgeBasesList />
      </ErrorBoundary>
    </div>
  );
}

function KnowledgeBasesList() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const pageFromUrl = searchParams.get("page");
  const pageSizeFromUrl = searchParams.get("pageSize");
  const search = searchParams.get("search") || "";
  // The trash view; the backend gates the deleted slice on
  // `knowledgeSource:delete`, and the status filter itself is gated the same way.
  const isDeletedView = searchParams.get("status") === "deleted";
  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const {
    data: knowledgeBases,
    isPending,
    isFetching,
    isLoadingError: isKnowledgeBasesLoadError,
    refetch: refetchKnowledgeBases,
  } = useKnowledgeBasesPaginated({
    limit: pageSize,
    offset,
    search: search || undefined,
    status: isDeletedView ? "deleted" : undefined,
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [permanentlyDeletingKb, setPermanentlyDeletingKb] =
    useState<KnowledgeBaseItem | null>(null);
  const restoreKnowledgeBase = useRestoreKnowledgeBase();
  const permanentlyDeleteKnowledgeBase = usePermanentlyDeleteKnowledgeBase();
  // Resolved once here rather than inside a cell renderer, as the shared
  // permanent-delete action requires.
  const admin = useIsGlobalAdmin();
  const editId = searchParams.get("edit");
  const { data: editingItemFromUrl } = useKnowledgeBase(editId ?? undefined);
  const {
    entity: editingItem,
    open: openEditDialog,
    close: closeEditDialog,
  } = useDialogUrlParam<
    KnowledgeBaseItem | archestraApiTypes.GetKnowledgeBaseResponses["200"]
  >({
    paramName: "edit",
    entityFromUrl: editingItemFromUrl ?? null,
  });
  // The connector edit dialog is owned here (one hook instance for the
  // page-level "connector" param); expanded rows only report which connector
  // to open it for.
  const connectorId = searchParams.get("connector");
  const { data: editingConnectorFromUrl } = useConnector(
    connectorId ?? undefined,
  );
  const {
    entity: editingConnector,
    open: openEditConnector,
    close: closeEditConnector,
  } = useDialogUrlParam<
    ConnectorItem | archestraApiTypes.GetConnectorResponses["200"]
  >({
    paramName: "connector",
    entityFromUrl: editingConnectorFromUrl ?? null,
  });
  const [addConnectorKbId, setAddConnectorKbId] = useState<string | null>(null);
  // Unassigning a connector is a per-connector action on a knowledge base, so
  // the dialog is owned here and the chips in either view just name a target.
  const [removingConnector, setRemovingConnector] = useState<{
    connectorId: string;
    knowledgeBaseId: string;
  } | null>(null);
  const { startChat, isCreating: isChatCreating } = useChatWithKnowledgeBase();
  const items = knowledgeBases?.data ?? [];
  const pagination = knowledgeBases?.pagination;
  // One query for every connector on the page, rather than one per knowledge
  // base as the expandable sub-table did. It also polls while any connector is
  // syncing, so the status dots stay live.
  const { data: allConnectorRecords } = useAllConnectors();
  const connectorsById = useMemo(
    () => new Map((allConnectorRecords ?? []).map((c) => [c.id, c])),
    [allConnectorRecords],
  );

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [selectAllMatchingFor, setSelectAllMatchingFor] = useState<
    string | null
  >(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteKnowledgeBases();

  // Changing a filter invalidates an escalation rather than silently
  // re-pointing "all N" at a different N.
  const filterSignature = `${search}|${isDeletedView}`;
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
    getRowId: (knowledgeBase) => knowledgeBase.id,
    rowSelection: effectiveRowSelection,
    setRowSelection: onRowSelectionChange,
    rangeSelection,
  });
  const { data: allMatching, isFetching: isFetchingAllMatching } =
    useAllMatchingKnowledgeBases(
      {
        search: search || undefined,
        status: isDeletedView ? "deleted" : undefined,
      },
      { enabled: allMatchingActive },
    );

  const clearSelection = useCallback(() => {
    setRowSelection({});
    setSelectAllMatchingFor(null);
  }, []);

  // The deleted view has its own lifecycle actions (restore, purge), so bulk
  // deletion is offered only over live knowledge bases.
  const pageSelection = isDeletedView
    ? []
    : items.filter((kb) => effectiveRowSelection[kb.id]);
  const selectedKnowledgeBases =
    allMatchingActive && allMatching ? allMatching : pageSelection;
  const goToPage = useCallback(
    (next: { pageIndex: number; pageSize: number }) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("page", String(next.pageIndex + 1));
      params.set("pageSize", String(next.pageSize));
      router.push(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const hasActiveFilters = !!search || isDeletedView;
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of ["search", "status"]) {
      params.delete(key);
    }
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  // Shared by the card grid and the table view, so an action behaves the same
  // whichever one the user is looking at.
  const rowActions = useCallback(
    (kb: KnowledgeBaseItem): TableRowAction[] => {
      const hasDocs = kb.totalDocsIndexed > 0;
      return [
        {
          icon: <MessageSquare className="h-4 w-4" />,
          label: "Talk to Knowledge Base",
          onClick: () => startChat(kb),
          disabled: isChatCreating || !hasDocs,
          disabledTooltip: hasDocs
            ? "Starting chat..."
            : "Add a connector and index documents to chat with this knowledge base",
        },
        {
          icon: <Plus className="h-4 w-4" />,
          label: "Add connector",
          onClick: () => setAddConnectorKbId(kb.id),
        },
        {
          icon: <Pencil className="h-4 w-4" />,
          label: "Edit",
          onClick: () => openEditDialog(kb),
        },
        {
          icon: <Trash2 className="h-4 w-4" />,
          label: "Delete",
          variant: "destructive",
          onClick: () => setDeletingId(kb.id),
        },
      ];
    },
    [startChat, isChatCreating, openEditDialog],
  );

  // The table view is the same information in rows, for anyone scanning many
  // knowledge bases at once. It has no expandable sub-table: the connectors
  // are named in their own column here, exactly as on the cards.
  const columns: ColumnDef<KnowledgeBaseItem>[] = [
    createSelectColumn<KnowledgeBaseItem>({
      rowLabel: (kb) => `Select ${kb.name}`,
      allLabel: "Select all knowledge bases on this page",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 320,
      cell: ({ row }) => {
        const kb = row.original;
        return (
          <div className="min-w-0">
            <div className="truncate font-medium">{kb.name}</div>
            {kb.description && (
              <div className="truncate text-xs text-muted-foreground">
                {kb.description}
              </div>
            )}
          </div>
        );
      },
    },
    {
      id: "connectors",
      header: "Connectors",
      size: 420,
      cell: ({ row }) => (
        <KnowledgeBaseConnectorList
          connectors={row.original.connectors}
          connectorsById={connectorsById}
          onEditConnector={openEditConnector}
          onRemoveConnector={(connectorId) =>
            setRemovingConnector({
              connectorId,
              knowledgeBaseId: row.original.id,
            })
          }
        />
      ),
    },
    {
      id: "docsIndexed",
      header: "Documents",
      size: 130,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.totalDocsIndexed.toLocaleString()}
        </span>
      ),
    },
    {
      id: "agents",
      header: "Agents",
      size: 110,
      cell: ({ row }) => (
        <span className="tabular-nums">
          {row.original.assignedAgents.length}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 170,
      cell: ({ row }) => (
        <TableRowActions
          actions={rowActions(row.original)}
          itemName={row.original.name}
        />
      ),
    },
  ];

  // The trash view. Rows do not expand — the connector sub-table is an
  // active-KB surface — and the actions collapse to Restore + Delete
  // permanently, matching the agents, skills, and projects trash views.
  const deletedColumns: ColumnDef<KnowledgeBaseItem>[] = [
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      cell: ({ row }) => {
        const kb = row.original;
        return (
          <div>
            <div className="font-medium">{kb.name}</div>
            {kb.description && (
              <div className="text-xs text-muted-foreground truncate max-w-md">
                {kb.description}
              </div>
            )}
          </div>
        );
      },
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
              onClick: () => restoreKnowledgeBase.mutate(row.original.id),
            },
            permanentDeleteRowAction({
              admin,
              onClick: () => setPermanentlyDeletingKb(row.original),
            }),
          ]}
        />
      ),
    },
  ];

  if (isKnowledgeBasesLoadError) {
    return (
      <KnowledgePageLayout
        title="Knowledge Bases"
        description={KNOWLEDGE_BASES_DESCRIPTION}
        createLabel="Create Knowledge Base"
        onCreateClick={() => setIsCreateDialogOpen(true)}
        isPending={false}
      >
        <QueryLoadError
          title="Couldn't load your knowledge bases"
          onRetry={() => refetchKnowledgeBases()}
        />
      </KnowledgePageLayout>
    );
  }

  return (
    <KnowledgePageLayout
      title="Knowledge Bases"
      description={KNOWLEDGE_BASES_DESCRIPTION}
      createLabel="Create Knowledge Base"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending && !knowledgeBases}
    >
      <TableCardView storageKey="knowledge-bases-view">
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
              <ResourceDeletedStatusFilter
                deletePermission={{ knowledgeSource: ["delete"] }}
              />
            </FilterBar>
          </CollectionFilters>

          {!isDeletedView && (
            <BulkActions
              count={selectedKnowledgeBases.length}
              noun="knowledge base"
              plural="knowledge bases"
              onClear={clearSelection}
              busy={bulkDelete.isPending || isFetchingAllMatching}
              selectAllMatching={{
                total: pagination?.total ?? items.length,
                pageFullySelected:
                  items.length > 0 &&
                  items.every((kb) => effectiveRowSelection[kb.id]),
                active: allMatchingActive,
                onSelectAll: () => setSelectAllMatchingFor(filterSignature),
                matchDescription: "match this search",
              }}
            >
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
              <KnowledgeBaseCardGrid
                knowledgeBases={items}
                connectorsById={connectorsById}
                cardSelection={cardSelection}
                rowActions={rowActions}
                onAddConnector={setAddConnectorKbId}
                onEditConnector={openEditConnector}
                onRemoveConnector={setRemovingConnector}
                isLoading={isFetching && items.length === 0}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                pagination={{
                  pageIndex,
                  pageSize,
                  total: pagination?.total ?? 0,
                }}
                onPaginationChange={goToPage}
              />
            }
            table={
              <DataTable
                columns={isDeletedView ? deletedColumns : columns}
                data={items}
                getRowId={(row) => row.id}
                rowSelection={isDeletedView ? undefined : effectiveRowSelection}
                onRowSelectionChange={
                  isDeletedView ? undefined : onRowSelectionChange
                }
                rangeSelection={rangeSelection}
                hideSelectedCount
                // The deleted view always counts as filtered (see hasActiveFilters),
                // so its empty state is the filtered one below.
                emptyIcon={Database}
                emptyMessage="No knowledge bases found"
                hasActiveFilters={hasActiveFilters}
                filteredEmptyMessage={
                  isDeletedView
                    ? "No deleted knowledge bases found."
                    : "No knowledge bases match your filters"
                }
                onClearFilters={clearFilters}
                manualPagination
                pagination={{
                  pageIndex,
                  pageSize,
                  total: pagination?.total ?? 0,
                }}
                onPaginationChange={goToPage}
                isLoading={isFetching}
              />
            }
          />

          {bulkDeleteOpen && (
            <DeleteConfirmDialog
              open={bulkDeleteOpen}
              onOpenChange={setBulkDeleteOpen}
              title="Delete knowledge bases"
              description={`Delete ${selectedKnowledgeBases.length} ${
                selectedKnowledgeBases.length === 1
                  ? "knowledge base"
                  : "knowledge bases"
              }? Their connectors survive and keep working; the agents using them lose that knowledge until it is reassigned.`}
              isPending={bulkDelete.isPending}
              onConfirm={() => {
                bulkDelete.mutate(selectedKnowledgeBases, {
                  onSuccess: (outcome) => {
                    reportBulkOutcome({
                      outcome,
                      verb: "Deleted",
                      failureVerb: "delete",
                      noun: "knowledge base",
                      plural: "knowledge bases",
                    });
                    setBulkDeleteOpen(false);
                    if (outcome.failed.length === 0) clearSelection();
                  },
                });
              }}
              confirmLabel="Delete knowledge bases"
              pendingLabel="Deleting..."
            />
          )}

          {permanentlyDeletingKb && (
            <DeleteConfirmDialog
              open={!!permanentlyDeletingKb}
              onOpenChange={(open) => {
                if (!open) setPermanentlyDeletingKb(null);
              }}
              title="Delete knowledge base permanently"
              description={`This destroys "${permanentlyDeletingKb.name}" along with its agent and connector assignments. Its connectors survive and keep working. Nothing recovers the knowledge base.`}
              isPending={permanentlyDeleteKnowledgeBase.isPending}
              onConfirm={async () => {
                const ok = await permanentlyDeleteKnowledgeBase.mutateAsync(
                  permanentlyDeletingKb.id,
                );
                if (ok) setPermanentlyDeletingKb(null);
              }}
              confirmLabel={PERMANENT_DELETE_LABEL}
            />
          )}

          <CreateKnowledgeBaseDialog
            open={isCreateDialogOpen}
            onOpenChange={setIsCreateDialogOpen}
          />

          {editingItem && (
            <EditKnowledgeBaseDialog
              knowledgeBase={editingItem}
              open={!!editingItem}
              onOpenChange={(open) => !open && closeEditDialog()}
            />
          )}

          {editingConnector && (
            <EditConnectorDialog
              connector={editingConnector}
              open={!!editingConnector}
              onOpenChange={(open) => !open && closeEditConnector()}
            />
          )}

          {deletingId && (
            <DeleteKnowledgeBaseDialog
              knowledgeBaseId={deletingId}
              open={!!deletingId}
              onOpenChange={(open) => !open && setDeletingId(null)}
            />
          )}

          {removingConnector && (
            <RemoveConnectorDialog
              connectorId={removingConnector.connectorId}
              knowledgeBaseId={removingConnector.knowledgeBaseId}
              open
              onOpenChange={(open) => !open && setRemovingConnector(null)}
            />
          )}

          {addConnectorKbId && (
            <AddConnectorDialog
              knowledgeBaseId={addConnectorKbId}
              assignedConnectorIds={
                new Set(
                  items
                    .find((kb) => kb.id === addConnectorKbId)
                    ?.connectors.map((c) => c.id) ?? [],
                )
              }
              open={!!addConnectorKbId}
              onOpenChange={(open) => !open && setAddConnectorKbId(null)}
            />
          )}
        </div>
      </TableCardView>
    </KnowledgePageLayout>
  );
}

// ===
// Card grid
// ===

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

/**
 * The knowledge bases themselves, one card each, with the same pagination bar
 * the table view uses so switching views does not change where you are in the
 * list.
 */
function KnowledgeBaseCardGrid({
  knowledgeBases,
  connectorsById,
  cardSelection,
  rowActions,
  onAddConnector,
  onEditConnector,
  onRemoveConnector,
  isLoading,
  hasActiveFilters,
  onClearFilters,
  pagination,
  onPaginationChange,
}: {
  knowledgeBases: KnowledgeBaseItem[];
  connectorsById: Map<string, ConnectorItem>;
  cardSelection: (knowledgeBase: KnowledgeBaseItem) => BulkCardSelectionProps;
  rowActions: (kb: KnowledgeBaseItem) => TableRowAction[];
  onAddConnector: (knowledgeBaseId: string) => void;
  onEditConnector: (connector: ConnectorItem) => void;
  onRemoveConnector: (target: {
    connectorId: string;
    knowledgeBaseId: string;
  }) => void;
  isLoading: boolean;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
  pagination: { pageIndex: number; pageSize: number; total: number };
  onPaginationChange: (next: { pageIndex: number; pageSize: number }) => void;
}) {
  if (isLoading) {
    return <LoadingState label="Loading knowledge bases…" variant="page" />;
  }

  if (knowledgeBases.length === 0) {
    return (
      <EmptyState
        icon={Database}
        title={
          hasActiveFilters
            ? "No knowledge bases match your filters"
            : "No knowledge bases found"
        }
        onClearFilters={hasActiveFilters ? onClearFilters : undefined}
      />
    );
  }

  return (
    <div className="space-y-4">
      <TableCardGrid>
        {knowledgeBases.map((kb) => (
          <KnowledgeBaseCard
            key={kb.id}
            knowledgeBase={kb}
            connectorsById={connectorsById}
            {...cardSelection(kb)}
            actions={rowActions(kb)}
            onAddConnector={() => onAddConnector(kb.id)}
            onEditConnector={onEditConnector}
            onRemoveConnector={(connectorId) =>
              onRemoveConnector({ connectorId, knowledgeBaseId: kb.id })
            }
          />
        ))}
      </TableCardGrid>
      <TablePagination
        pageIndex={pagination.pageIndex}
        pageSize={pagination.pageSize}
        total={pagination.total}
        onPaginationChange={onPaginationChange}
      />
    </div>
  );
}

/**
 * The connectors of one knowledge base, named rather than counted, for the
 * table view's Connectors column.
 */
function KnowledgeBaseConnectorList({
  connectors,
  connectorsById,
  onEditConnector,
  onRemoveConnector,
}: {
  connectors: KnowledgeBaseItem["connectors"];
  connectorsById: Map<string, ConnectorItem>;
  onEditConnector: (connector: ConnectorItem) => void;
  onRemoveConnector: (connectorId: string) => void;
}) {
  if (connectors.length === 0) {
    return <span className="text-sm text-muted-foreground">None</span>;
  }
  const visible = connectors.slice(0, 2);
  const hidden = connectors.slice(2);
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {visible.map((connector) => (
        <ConnectorChip
          key={connector.id}
          connector={connector}
          detail={connectorsById.get(connector.id)}
          onEdit={onEditConnector}
          onRemove={onRemoveConnector}
        />
      ))}
      {hidden.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="cursor-default rounded-md border px-2 py-1 text-xs text-muted-foreground">
              +{hidden.length} more
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs">
            <div className="space-y-0.5">
              {hidden.map((connector) => (
                <div key={connector.id}>{connector.name}</div>
              ))}
            </div>
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

// ===
// Dialogs
// ===

function AddConnectorDialog({
  knowledgeBaseId,
  assignedConnectorIds,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  assignedConnectorIds: Set<string>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"choose" | "reuse" | "create">("choose");
  const { data: allConnectors } = useAllConnectors();
  const assignMutation = useAssignConnectorToKnowledgeBases();
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");

  const availableConnectors = (allConnectors ?? [])
    .filter((c) => !assignedConnectorIds.has(c.id))
    .filter(
      (c) =>
        c.name.toLowerCase().includes(search.toLowerCase()) ||
        c.description?.toLowerCase().includes(search.toLowerCase()) ||
        c.connectorType.toLowerCase().includes(search.toLowerCase()),
    );

  const toggleSelected = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleAssign = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const results = await Promise.allSettled(
      [...selectedIds].map((connectorId) =>
        assignMutation.mutateAsync({
          connectorId,
          knowledgeBaseIds: [knowledgeBaseId],
        }),
      ),
    );

    const failedCount = results.filter(
      (result) => result.status === "rejected",
    ).length;

    if (failedCount > 0) {
      toast.error(
        failedCount === selectedIds.size
          ? "Failed to assign connectors"
          : `${failedCount} connector assignment${failedCount === 1 ? "" : "s"} failed`,
      );
    }

    setSelectedIds(new Set());
    setStep("choose");
    onOpenChange(false);
  }, [selectedIds, knowledgeBaseId, assignMutation, onOpenChange]);

  const handleClose = (isOpen: boolean) => {
    if (!isOpen) {
      setStep("choose");
      setSelectedIds(new Set());
    }
    onOpenChange(isOpen);
  };

  useLayoutEffect(() => {
    if (step === "reuse") {
      searchRef.current?.focus();
    }
  }, [step]);

  return (
    <>
      <StandardDialog
        open={open && step !== "create"}
        onOpenChange={handleClose}
        title={
          step === "choose" ? (
            "Add Connector"
          ) : (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => {
                  setStep("choose");
                  setSelectedIds(new Set());
                }}
                aria-label="Go back"
              >
                <ArrowLeft className="h-4 w-4" />
              </Button>
              <span>Select Connectors</span>
            </div>
          )
        }
        description={
          step === "choose"
            ? "Reuse an existing Connector or create a new one."
            : "Choose Connectors to assign to this Knowledge Base."
        }
        size="small"
        footer={
          step === "reuse" ? (
            <>
              <Button
                variant="outline"
                onClick={() => {
                  setStep("choose");
                  setSelectedIds(new Set());
                }}
              >
                Cancel
              </Button>
              <Button
                onClick={handleAssign}
                disabled={selectedIds.size === 0 || assignMutation.isPending}
              >
                {assignMutation.isPending
                  ? "Assigning..."
                  : `Assign ${selectedIds.size > 0 ? `(${selectedIds.size})` : ""}`}
              </Button>
            </>
          ) : null
        }
      >
        {step === "choose" && (
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setStep("reuse")}
              disabled={availableConnectors.length === 0}
              className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                <Link2 className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <div className="font-medium">Reuse Existing</div>
                <div className="text-xs text-muted-foreground mt-1">
                  {availableConnectors.length === 0
                    ? "No unassigned connectors"
                    : `${availableConnectors.length} available`}
                </div>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setStep("create")}
              className="flex flex-col items-center gap-3 rounded-lg border p-5 text-center transition-colors hover:bg-muted/50 cursor-pointer"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
                <Plus className="h-7 w-7 text-muted-foreground" />
              </div>
              <div>
                <div className="font-medium">Create New</div>
                <div className="text-xs text-muted-foreground mt-1">
                  Set up a new Connector
                </div>
              </div>
            </button>
          </div>
        )}

        {step === "reuse" && (
          <>
            <SearchInput
              ref={searchRef}
              value={search}
              onSearchChange={setSearch}
              syncQueryParams={false}
              debounceMs={300}
              className="relative w-[370px]"
              inputClassName="w-full bg-background/50 backdrop-blur-sm border-border/50 focus:border-primary/50 transition-colors pl-9"
            />
            <div className="grid max-h-[50vh] grid-cols-2 gap-3 overflow-y-auto pt-4">
              {availableConnectors.length ? (
                availableConnectors.map((connector) => {
                  const isSelected = selectedIds.has(connector.id);
                  return (
                    <button
                      key={connector.id}
                      type="button"
                      onClick={() => toggleSelected(connector.id)}
                      className={cn(
                        "relative flex items-center gap-3 rounded-lg border p-3 text-left transition-colors cursor-pointer hover:bg-muted/50",
                        isSelected && "border-primary bg-primary/5",
                      )}
                    >
                      {isSelected && (
                        <div className="absolute top-2 right-2">
                          <Check className="h-4 w-4 text-primary" />
                        </div>
                      )}
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
                        <ConnectorTypeIcon
                          type={connector.connectorType}
                          className="h-5 w-5"
                        />
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium text-sm truncate">
                          {connector.name}
                        </div>
                        <div className="text-xs text-muted-foreground capitalize">
                          {connector.connectorType}
                        </div>
                      </div>
                    </button>
                  );
                })
              ) : (
                <div className="col-span-2 flex flex-col items-center gap-2 rounded-lg border border-muted/50 p-5 text-center text-sm text-muted-foreground">
                  No connectors match your filters. Try adjusting your search.
                </div>
              )}
            </div>
          </>
        )}
      </StandardDialog>

      <CreateConnectorDialog
        knowledgeBaseId={knowledgeBaseId}
        open={open && step === "create"}
        onBack={() => setStep("choose")}
        onOpenChange={(isOpen) => {
          if (!isOpen) {
            setStep("choose");
            onOpenChange(false);
          }
        }}
      />
    </>
  );
}

function RemoveConnectorDialog({
  connectorId,
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  connectorId: string;
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const unassignMutation = useUnassignConnectorFromKnowledgeBase();

  const handleRemove = useCallback(async () => {
    const result = await unassignMutation.mutateAsync({
      connectorId,
      knowledgeBaseId,
    });
    if (result) {
      onOpenChange(false);
    }
  }, [connectorId, knowledgeBaseId, unassignMutation, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Remove Connector"
      description="Are you sure you want to remove this connector from the knowledge base? The connector itself will not be deleted and can be re-added later."
      isPending={unassignMutation.isPending}
      onConfirm={handleRemove}
      confirmLabel="Remove Connector"
      pendingLabel="Removing..."
    />
  );
}

function DeleteKnowledgeBaseDialog({
  knowledgeBaseId,
  open,
  onOpenChange,
}: {
  knowledgeBaseId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteKnowledgeBase = useDeleteKnowledgeBase();

  const handleDelete = useCallback(async () => {
    const result = await deleteKnowledgeBase.mutateAsync(knowledgeBaseId);
    if (result) {
      onOpenChange(false);
    }
  }, [knowledgeBaseId, deleteKnowledgeBase, onOpenChange]);

  return (
    <DeleteConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Delete Knowledge Base"
      description="Are you sure you want to delete this knowledge base? Its connectors are not deleted and keep working. An admin can restore it from the Deleted view until it is permanently removed."
      isPending={deleteKnowledgeBase.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Knowledge Base"
      pendingLabel="Deleting..."
    />
  );
}
