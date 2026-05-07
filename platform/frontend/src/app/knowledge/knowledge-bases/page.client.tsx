"use client";

import type { archestraApiTypes } from "@shared";
import type { ColumnDef } from "@tanstack/react-table";
import { formatDistanceToNow } from "date-fns";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Link2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { KnowledgePageLayout } from "@/app/knowledge/_parts/knowledge-page-layout";
import { ConnectorStatusBadge } from "@/app/knowledge/knowledge-bases/_parts/connector-status-badge";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { SearchInput } from "@/components/search-input";
import { StandardDialog } from "@/components/standard-dialog";
import {
  type TableRowAction,
  TableRowActions,
} from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { DEFAULT_TABLE_LIMIT } from "@/consts";
import {
  useConnectors as useAllConnectors,
  useAssignConnectorToKnowledgeBases,
  useConnectors,
  useUnassignConnectorFromKnowledgeBase,
} from "@/lib/knowledge/connector.query";
import {
  useDeleteKnowledgeBase,
  useKnowledgeBasesPaginated,
} from "@/lib/knowledge/knowledge-base.query";
import { cn, formatDate } from "@/lib/utils";
import { ConnectorTypeIcon } from "./_parts/connector-icons";
import { CreateConnectorDialog } from "./_parts/create-connector-dialog";
import { CreateKnowledgeBaseDialog } from "./_parts/create-knowledge-base-dialog";
import { EditConnectorDialog } from "./_parts/edit-connector-dialog";
import { EditKnowledgeBaseDialog } from "./_parts/edit-knowledge-base-dialog";

type KnowledgeBaseItem =
  archestraApiTypes.GetKnowledgeBasesResponses["200"]["data"][number];

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
  const pageIndex = Number(pageFromUrl || "1") - 1;
  const pageSize = Number(pageSizeFromUrl || DEFAULT_TABLE_LIMIT);
  const offset = pageIndex * pageSize;

  const {
    data: knowledgeBases,
    isPending,
    isFetching,
  } = useKnowledgeBasesPaginated({
    limit: pageSize,
    offset,
    search: search || undefined,
  });
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editingItem, setEditingItem] = useState<KnowledgeBaseItem | null>(
    null,
  );
  const [addConnectorKbId, setAddConnectorKbId] = useState<string | null>(null);

  const items = knowledgeBases?.data ?? [];
  const pagination = knowledgeBases?.pagination;
  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("search");
    params.set("page", "1");
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }, [pathname, router, searchParams]);

  const columns: ColumnDef<KnowledgeBaseItem>[] = [
    {
      id: "expand",
      size: 40,
      header: () => null,
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={(e) => {
            e.stopPropagation();
            row.toggleExpanded();
          }}
        >
          {row.getIsExpanded() ? (
            <ChevronDown className="h-4 w-4" />
          ) : (
            <ChevronRight className="h-4 w-4" />
          )}
        </Button>
      ),
    },
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
      id: "connectors",
      header: "Connectors",
      cell: ({ row }) => <div>{row.original.connectors.length}</div>,
    },
    {
      id: "docsIndexed",
      header: "Docs Indexed",
      cell: ({ row }) => <div>{row.original.totalDocsIndexed}</div>,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => {
        const kb = row.original;
        const actions: TableRowAction[] = [
          {
            icon: <Plus className="h-4 w-4" />,
            label: "Add connector",
            onClick: () => setAddConnectorKbId(kb.id),
          },
          {
            icon: <Pencil className="h-4 w-4" />,
            label: "Edit",
            onClick: () => setEditingItem(kb),
          },
          {
            icon: <Trash2 className="h-4 w-4" />,
            label: "Delete",
            variant: "destructive",
            onClick: () => setDeletingId(kb.id),
          },
        ];
        return <TableRowActions actions={actions} />;
      },
    },
  ];

  return (
    <KnowledgePageLayout
      title="Knowledge Bases"
      description="Manage knowledge bases and their data connectors."
      createLabel="Create Knowledge Base"
      onCreateClick={() => setIsCreateDialogOpen(true)}
      isPending={isPending && !knowledgeBases}
    >
      <div>
        <div className="mb-6 flex flex-col gap-2">
          <div className="flex items-center gap-4">
            <SearchInput paramName="search" className="relative w-[370px]" />
          </div>
        </div>

        <DataTable
          columns={columns}
          data={items}
          renderSubComponent={({ row }) => (
            <ExpandedConnectors knowledgeBaseId={row.original.id} />
          )}
          emptyMessage="No knowledge bases found"
          hasActiveFilters={!!search}
          filteredEmptyMessage="No knowledge bases match your filters. Try adjusting your search."
          onClearFilters={clearFilters}
          hideSelectedCount
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: pagination?.total ?? 0,
          }}
          onPaginationChange={(newPagination) => {
            const params = new URLSearchParams(searchParams.toString());
            params.set("page", String(newPagination.pageIndex + 1));
            params.set("pageSize", String(newPagination.pageSize));
            router.push(`${pathname}?${params.toString()}`, { scroll: false });
          }}
          isLoading={isFetching}
        />

        <CreateKnowledgeBaseDialog
          open={isCreateDialogOpen}
          onOpenChange={setIsCreateDialogOpen}
        />

        {editingItem && (
          <EditKnowledgeBaseDialog
            knowledgeBase={editingItem}
            open={!!editingItem}
            onOpenChange={(open) => !open && setEditingItem(null)}
          />
        )}

        {deletingId && (
          <DeleteKnowledgeBaseDialog
            knowledgeBaseId={deletingId}
            open={!!deletingId}
            onOpenChange={(open) => !open && setDeletingId(null)}
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
    </KnowledgePageLayout>
  );
}

// ===
// Expanded connectors sub-row
// ===

type ConnectorItem =
  archestraApiTypes.GetConnectorsResponses["200"]["data"][number];

function ExpandedConnectors({ knowledgeBaseId }: { knowledgeBaseId: string }) {
  const router = useRouter();
  const { data: connectors, isPending } = useConnectors(knowledgeBaseId);
  const [editingConnector, setEditingConnector] =
    useState<ConnectorItem | null>(null);
  const [removingConnectorId, setRemovingConnectorId] = useState<string | null>(
    null,
  );

  const items = connectors ?? [];

  const columns: ColumnDef<ConnectorItem>[] = [
    {
      id: "name",
      header: "Connector",
      cell: ({ row }) => (
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
            <ConnectorTypeIcon
              type={row.original.connectorType}
              className="h-5 w-5"
            />
          </div>
          <div className="min-w-0">
            <div className="font-medium truncate">{row.original.name}</div>
            <div className="text-xs text-muted-foreground truncate">
              {row.original.description || row.original.connectorType}
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.lastSyncAt ? (
          <div className="flex items-center gap-2">
            <ConnectorStatusBadge status={row.original.lastSyncStatus} />
            <span
              className="text-xs text-muted-foreground"
              title={formatDate({ date: row.original.lastSyncAt })}
            >
              {formatDistanceToNow(new Date(row.original.lastSyncAt), {
                addSuffix: true,
              })}
            </span>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Never synced</span>
        ),
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => (
        <TableRowActions
          actions={[
            {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit connector",
              onClick: () => setEditingConnector(row.original),
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Remove from knowledge base",
              variant: "destructive",
              onClick: () => setRemovingConnectorId(row.original.id),
            },
          ]}
          size="sm"
        />
      ),
    },
  ];

  return (
    <>
      <div className="p-4">
        <DataTable
          columns={columns}
          data={items}
          getRowId={(row) => row.id}
          hideSelectedCount
          isLoading={isPending}
          emptyMessage="No connectors associated with this knowledge base"
          onRowClick={(row) =>
            router.push(`/knowledge/connectors/${row.id}?from=knowledge-bases`)
          }
          manualPagination
        />
      </div>

      {editingConnector && (
        <EditConnectorDialog
          connector={editingConnector}
          open={!!editingConnector}
          onOpenChange={(open) => !open && setEditingConnector(null)}
        />
      )}

      {removingConnectorId && (
        <RemoveConnectorDialog
          connectorId={removingConnectorId}
          knowledgeBaseId={knowledgeBaseId}
          open={!!removingConnectorId}
          onOpenChange={(open) => !open && setRemovingConnectorId(null)}
        />
      )}
    </>
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
      description="Are you sure you want to delete this knowledge base? Connectors will not be deleted but will be unlinked from this knowledge base. This action cannot be undone."
      isPending={deleteKnowledgeBase.isPending}
      onConfirm={handleDelete}
      confirmLabel="Delete Knowledge Base"
      pendingLabel="Deleting..."
    />
  );
}
