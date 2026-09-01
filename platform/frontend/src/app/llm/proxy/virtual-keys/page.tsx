"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import {
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetLlmProxyAction } from "@/app/llm/proxy/_parts/llm-proxy-action-context";
import {
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EditVirtualKeyDialog } from "@/components/edit-virtual-key-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import {
  isProviderApiKeyId,
  ProviderKeyFilterSelect,
} from "@/components/provider-key-filter-select";
import { formatProviderKeySummary } from "@/components/provider-key-mappings-field";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import {
  TableCard,
  TableCardList,
  TableCardView,
  TableCardViewContent,
  TableCardViewToggle,
} from "@/components/table-card-view";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useBulkRangeSelectionController } from "@/lib/bulk-range-selection-context";
import { copyToClipboard } from "@/lib/clipboard";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  formatRelativeTime,
  formatRelativeTimeFromNow,
} from "@/lib/utils/date-time";
import {
  useAllVirtualApiKeys,
  useBulkDeleteVirtualApiKeys,
  useDeleteVirtualApiKey,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

type VirtualKeyRow =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
type KeyTypeFilter = NonNullable<
  NonNullable<archestraApiTypes.GetAllVirtualApiKeysData["query"]>["keyType"]
>;
type ScopeFilter = NonNullable<
  NonNullable<archestraApiTypes.GetAllVirtualApiKeysData["query"]>["scope"]
>;

export default function VirtualKeysPage() {
  return (
    <ErrorBoundary>
      <VirtualKeysTable />
    </ErrorBoundary>
  );
}

function VirtualKeysTable() {
  const setActionButton = useSetLlmProxyAction();
  const {
    searchParams,
    pageIndex,
    pageSize,
    offset,
    updateQueryParams,
    setPagination,
  } = useDataTableQueryParams();

  const searchFromUrl = searchParams.get("search") || "";
  const keyTypeFromUrl = searchParams.get("keyType");
  const scopeFromUrl = searchParams.get("scope");
  const providerApiKeyIdFromUrl = searchParams.get("providerApiKeyId");
  const keyTypeFilter = isKeyType(keyTypeFromUrl) ? keyTypeFromUrl : undefined;
  const scopeFilter = isScope(scopeFromUrl) ? scopeFromUrl : undefined;
  const providerApiKeyIdFilter = isProviderApiKeyId(providerApiKeyIdFromUrl)
    ? providerApiKeyIdFromUrl
    : undefined;

  const providerCatalog = useModelProviderCatalog();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canCreate } = useHasPermissions({ llmVirtualKey: ["create"] });

  const query = useAllVirtualApiKeys({
    limit: pageSize,
    offset,
    search: searchFromUrl || undefined,
    keyType: keyTypeFilter,
    scope: scopeFilter,
    providerApiKeyId: providerApiKeyIdFilter,
    toastOnError: false,
  });

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [editingKey, setEditingKey] = useState<VirtualKeyRow | null>(null);
  const [deletingKey, setDeletingKey] = useState<VirtualKeyRow | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const deleteMutation = useDeleteVirtualApiKey();
  const bulkDelete = useBulkDeleteVirtualApiKeys();

  const clearSelection = useCallback(() => setRowSelection({}), []);

  // The header's Create control: a small menu, because standard and
  // passthrough keys are created through the same dialog in different modes.
  useEffect(() => {
    setActionButton(
      canCreate ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <Plus className="h-4 w-4" />
              <span>Create Virtual Key</span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-w-72">
            <DropdownMenuItem
              className="flex-col items-start gap-0.5"
              onSelect={() => setCreateKeyType("standard")}
            >
              <span className="font-medium">Standard virtual key</span>
              <span className="text-xs text-muted-foreground">
                Authenticates your app through your provider keys
              </span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="flex-col items-start gap-0.5"
              onSelect={() => setCreateKeyType("passthrough")}
            >
              <span className="font-medium">Passthrough virtual key</span>
              <span className="text-xs text-muted-foreground">
                Grants no access; attributes bring-your-own-key requests to a
                user
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <PermissionButton permissions={{ llmVirtualKey: ["create"] }}>
          <Plus className="h-4 w-4" />
          <span>Create Virtual Key</span>
        </PermissionButton>
      ),
    );
    return () => setActionButton(null);
  }, [canCreate, setActionButton]);

  const keys = query.data?.data ?? [];
  const pagination = query.data?.pagination;
  const rangeSelection = useBulkRangeSelectionController();
  const cardSelection = useBulkCardSelection({
    rows: keys,
    getRowId: (key) => key.id,
    rowSelection,
    setRowSelection,
    rangeSelection,
  });
  const selectedKeys = keys.filter((key) => rowSelection[key.id]);
  const hasActiveFilters = Boolean(
    searchFromUrl || keyTypeFilter || scopeFilter || providerApiKeyIdFilter,
  );

  const clearFilters = useCallback(() => {
    updateQueryParams({
      search: null,
      keyType: null,
      scope: null,
      providerApiKeyId: null,
      page: "1",
    });
  }, [updateQueryParams]);

  const columns: ColumnDef<VirtualKeyRow>[] = [
    createSelectColumn<VirtualKeyRow>({
      rowLabel: (row) => `Select ${row.name}`,
      allLabel: "Select all keys on this page",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 200,
      cell: ({ row }) => (
        <span className="block max-w-[200px] truncate font-medium">
          {row.original.name}
        </span>
      ),
    },
    {
      id: "keyType",
      header: "Type",
      size: 120,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.keyType === "passthrough" ? "Passthrough" : "Standard"}
        </Badge>
      ),
    },
    {
      id: "token",
      header: "Token",
      size: 200,
      cell: ({ row }) => (
        <VirtualKeyValueCell
          id={row.original.id}
          tokenStart={row.original.tokenStart}
          canReveal={row.original.authorId === currentUserId}
        />
      ),
    },
    {
      id: "providers",
      header: "Providers",
      size: 160,
      cell: ({ row }) => (
        <span className="block max-w-[160px] truncate text-muted-foreground">
          {row.original.keyType === "passthrough" ? (
            <span>—</span>
          ) : (
            <span>
              {formatProviderKeySummary(
                row.original.providerApiKeys,
                providerCatalog.label,
              )}
            </span>
          )}
        </span>
      ),
    },
    {
      id: "accessibleTo",
      header: "Accessible to",
      size: 160,
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.scope}
          teams={row.original.teams}
          authorId={row.original.authorId}
          authorName={row.original.authorName}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "expiresAt",
      header: "Expires",
      size: 110,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatRelativeTime(row.original.expiresAt, {
            pastLabel: "Expired",
          })}
        </span>
      ),
    },
    {
      id: "lastUsedAt",
      header: "Last used",
      size: 110,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {formatRelativeTimeFromNow(row.original.lastUsedAt)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.name}
          actions={[
            {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit",
              permissions: { llmVirtualKey: ["update"] },
              onClick: () => setEditingKey(row.original),
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete",
              permissions: { llmVirtualKey: ["delete"] },
              variant: "destructive",
              onClick: () => setDeletingKey(row.original),
            },
          ]}
        />
      ),
    },
  ];

  if (query.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load virtual keys"
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <TableCardView storageKey="archestra-llm-virtual-keys-view">
      <div>
        <CollectionFilters>
          <FilterBar leading actions={<TableCardViewToggle />}>
            <SearchInput
              isLoading={query.isFetching}
              objectNamePlural="keys"
              searchFields={["name"]}
              paramName="search"
              className={filterSearchClass}
            />
            <FilterSelect
              value={keyTypeFilter ?? "all"}
              onValueChange={(value) =>
                updateQueryParams({
                  keyType: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by type"
              items={[
                { value: "all", label: "All types" },
                { value: "standard", label: "Standard" },
                { value: "passthrough", label: "Passthrough" },
              ]}
            />
            <FilterSelect
              value={scopeFilter ?? "all"}
              onValueChange={(value) =>
                updateQueryParams({
                  scope: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by visibility"
              items={[
                { value: "all", label: "All visibilities" },
                { value: "org", label: "Organization" },
                { value: "team", label: "Teams" },
                { value: "personal", label: "Personal" },
              ]}
            />
            <ProviderKeyFilterSelect
              value={providerApiKeyIdFilter}
              onValueChange={(providerApiKeyId) =>
                updateQueryParams({ providerApiKeyId, page: "1" })
              }
            />
          </FilterBar>
        </CollectionFilters>

        <BulkActions
          count={selectedKeys.length}
          noun="key"
          onClear={clearSelection}
          busy={bulkDelete.isPending}
        >
          <PermissionButton
            permissions={{ llmVirtualKey: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            <span>Delete</span>
          </PermissionButton>
        </BulkActions>

        <TableCardViewContent
          cards={
            <TableCardList
              itemCount={keys.length}
              isLoading={query.isFetching}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clearFilters}
              emptyIcon={KeyRound}
              emptyMessage="No virtual keys yet. Create one and choose its provider key mappings."
              filteredEmptyMessage="No virtual keys match your filters"
              pagination={{
                pageIndex,
                pageSize,
                total: pagination?.total ?? 0,
              }}
              onPaginationChange={setPagination}
            >
              {keys.map((key) => (
                <TableCard
                  key={key.id}
                  icon={<KeyRound className="h-5 w-5" />}
                  title={key.name}
                  {...cardSelection(key)}
                  selectionLabel={`Select ${key.name}`}
                  actions={
                    <TableRowActions
                      itemName={key.name}
                      actions={[
                        {
                          icon: <Pencil className="h-4 w-4" />,
                          label: "Edit",
                          permissions: { llmVirtualKey: ["update"] },
                          onClick: () => setEditingKey(key),
                        },
                        {
                          icon: <Trash2 className="h-4 w-4" />,
                          label: "Delete",
                          permissions: { llmVirtualKey: ["delete"] },
                          variant: "destructive",
                          onClick: () => setDeletingKey(key),
                        },
                      ]}
                    />
                  }
                  footer={
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      <span>
                        Expiry:{" "}
                        {formatRelativeTime(key.expiresAt, {
                          pastLabel: "Expired",
                        })}
                      </span>
                      <span>
                        Last used: {formatRelativeTimeFromNow(key.lastUsedAt)}
                      </span>
                    </div>
                  }
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {key.keyType === "passthrough" ? (
                          <span>Passthrough</span>
                        ) : (
                          <span>Standard</span>
                        )}
                      </Badge>
                      <ResourceVisibilityBadge
                        scope={key.scope}
                        teams={key.teams}
                        authorId={key.authorId}
                        authorName={key.authorName}
                        currentUserId={currentUserId}
                        showSelfAsMe
                      />
                    </div>
                    {/* Token left, mapped providers in the row's spare width. */}
                    <div className="flex items-center justify-between gap-3">
                      <VirtualKeyValueCell
                        id={key.id}
                        tokenStart={key.tokenStart}
                        canReveal={key.authorId === currentUserId}
                      />
                      {key.keyType !== "passthrough" && (
                        <p className="min-w-0 shrink truncate text-right text-xs text-muted-foreground">
                          {formatProviderKeySummary(
                            key.providerApiKeys,
                            providerCatalog.label,
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                </TableCard>
              ))}
            </TableCardList>
          }
          table={
            <DataTable
              columns={columns}
              data={keys}
              getRowId={(row) => row.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
              rangeSelection={rangeSelection}
              hideSelectedCount
              manualPagination
              pagination={{
                pageIndex,
                pageSize,
                total: pagination?.total ?? 0,
              }}
              onPaginationChange={setPagination}
              isLoading={query.isFetching}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clearFilters}
              emptyMessage="No virtual keys yet. Create one and choose its provider key mappings."
              filteredEmptyMessage="No virtual keys match your filters. Try adjusting your search."
            />
          }
        />

        <CreateVirtualKeyDialogWithData
          open={createKeyType !== null}
          onOpenChange={(open) => {
            if (!open) setCreateKeyType(null);
          }}
          keyType={createKeyType ?? "standard"}
        />
        <EditVirtualKeyDialog
          virtualKey={editingKey}
          onOpenChange={(open) => {
            if (!open) setEditingKey(null);
          }}
        />
        <DeleteConfirmDialog
          open={!!deletingKey}
          onOpenChange={(open) => {
            if (!open) setDeletingKey(null);
          }}
          title="Delete Virtual Key"
          description={`Are you sure you want to delete "${deletingKey?.name}"? This action cannot be undone.`}
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => {
            if (!deletingKey) return;
            deleteMutation.mutate(
              { id: deletingKey.id },
              { onSuccess: () => setDeletingKey(null) },
            );
          }}
        />
        {bulkDeleteOpen && (
          <DeleteConfirmDialog
            open={bulkDeleteOpen}
            onOpenChange={setBulkDeleteOpen}
            title="Delete virtual keys"
            description={`Delete ${selectedKeys.length} ${
              selectedKeys.length === 1 ? "key" : "keys"
            }? Applications using them stop authenticating. This cannot be undone.`}
            isPending={bulkDelete.isPending}
            onConfirm={() => {
              bulkDelete.mutate(selectedKeys, {
                onSuccess: (outcome) => {
                  reportBulkOutcome({
                    outcome,
                    verb: "Deleted",
                    failureVerb: "delete",
                    noun: "key",
                  });
                  setBulkDeleteOpen(false);
                  // Rows that failed stay ticked so the selection can be
                  // retried rather than rebuilt.
                  if (outcome.failed.length === 0) clearSelection();
                },
              });
            }}
            confirmLabel="Delete keys"
            pendingLabel="Deleting..."
          />
        )}
      </div>
    </TableCardView>
  );
}

/**
 * The token cell: masked prefix with author-only reveal/copy — the backend
 * 403s value reads for keys created by someone else.
 */
function VirtualKeyValueCell({
  id,
  tokenStart,
  canReveal,
}: {
  id: string;
  tokenStart: string;
  canReveal: boolean;
}) {
  const fetchValue = useFetchVirtualApiKeyValue();
  const [value, setValue] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const resolveValue = async () => {
    if (value) return value;
    const fetched = await fetchValue.mutateAsync(id);
    if (fetched) setValue(fetched);
    return fetched;
  };
  return (
    // min-w-0 + overflow-hidden: the DataTable's fixed layout does not clip
    // cell content, so an unconstrained flex row paints over the next column.
    <div className="flex min-w-0 items-center gap-1 overflow-hidden font-mono text-xs">
      <code
        className={visible && value ? "min-w-0 break-all" : "min-w-0 truncate"}
      >
        {visible && value ? value : `${tokenStart}…`}
      </code>
      {canReveal && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label={visible ? "Hide key" : "Reveal key"}
            disabled={fetchValue.isPending}
            onClick={async () => {
              if (!visible && !(await resolveValue())) return;
              setVisible(!visible);
            }}
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="shrink-0"
            aria-label="Copy key"
            disabled={fetchValue.isPending}
            onClick={async () => {
              const resolved = await resolveValue();
              if (!resolved) return;
              await copyToClipboard(resolved);
              toast.success("Key copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

function isKeyType(value: string | null): value is KeyTypeFilter {
  return value === "standard" || value === "passthrough";
}

function isScope(value: string | null): value is ScopeFilter {
  return value === "org" || value === "team" || value === "personal";
}
