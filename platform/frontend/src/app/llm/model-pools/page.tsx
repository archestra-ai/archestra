"use client";

import {
  DocsPage,
  isModelPoolProvider,
  type SupportedProvider,
} from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { Layers, Pencil, Plug, Plus, Server, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { useCallback, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
import { ExternalDocsLink } from "@/components/external-docs-link";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { PageLayout } from "@/components/page-layout";
import { QueryLoadError } from "@/components/query-load-error";
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
import { useHasPermissions } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { useBulkRangeSelectionController } from "@/lib/bulk-range-selection-context";
import { useFeature } from "@/lib/config/config.query";
import { getFrontendDocsUrl } from "@/lib/docs/docs";
import { useBulkCardSelection } from "@/lib/hooks/use-bulk-card-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type ModelPool,
  useBulkDeleteModelPools,
  useDeleteModelPool,
  useModelPools,
} from "@/lib/model-pools.query";
import {
  type ConnectablePool,
  ConnectPoolDialog,
} from "./_parts/connect-pool-dialog";
import { PoolHealth } from "./_parts/member-status";
import { PoolDialog } from "./_parts/pool-dialog";
import { memberSummary } from "./_parts/pool-form";
import { PoolProviderIcons, PoolProviders } from "./_parts/pool-providers";

const DESCRIPTION = (
  <>
    <span>
      Serve one model name from several provider keys, with load balancing and
      failover.
    </span>{" "}
    <ExternalDocsLink
      href={getFrontendDocsUrl(DocsPage.PlatformLlmProxyModelPools)}
      showIcon={false}
    >
      Read more in the docs
    </ExternalDocsLink>
  </>
);

const EMPTY_MESSAGE =
  "No model pools yet. Create one to serve a model from several provider keys.";

export default function ModelPoolsPage() {
  // Model pools are a beta feature: while this deployment has them off, the
  // page is not there, as their API is not.
  const enabled = useFeature("llmModelPoolsEnabled");
  if (enabled === false) notFound();
  if (enabled !== true) return null;
  return <ModelPools />;
}

function ModelPools() {
  // Benched members come back within a minute, so the list stays fresh.
  const query = useModelPools({ refetchInterval: 5_000, toastOnError: false });
  const pools = query.data ?? [];
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = (searchParams.get("search") ?? "").trim().toLowerCase();
  const providerFilter = searchParams.get("provider") ?? "all";
  const statusFilter = searchParams.get("status") ?? "all";

  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The pool itself, so a pool just created shows before the list refetches.
  const [connecting, setConnecting] = useState<{
    pool: ConnectablePool;
    ready: boolean;
  } | null>(null);
  const [deleting, setDeleting] = useState<ModelPool | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const deletePool = useDeleteModelPool();
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const bulkDelete = useBulkDeleteModelPools();
  const clearSelection = useCallback(() => setRowSelection({}), []);
  const providerCatalog = useModelProviderCatalog();

  const { data: canReadProviders } = useHasPermissions({
    llmProviderApiKey: ["read"],
  });
  const providerKeys = useLlmProviderApiKeys({
    enabled: canReadProviders === true,
    toastOnError: false,
  });
  const needsFirstProvider =
    canReadProviders === true &&
    providerKeys.isSuccess &&
    // Only shared keys on a provider a pool can serve are of use here.
    !providerKeys.data.some(
      (key) => key.userId === null && isModelPoolProvider(key.provider),
    ) &&
    query.isSuccess &&
    pools.length === 0;

  const visible = pools.filter(
    (pool) =>
      (!search || pool.name.toLowerCase().includes(search)) &&
      (providerFilter === "all" ||
        pool.members.some((member) => member.provider === providerFilter)) &&
      (statusFilter === "all" ||
        (statusFilter === "benched" && hasBenchedMember(pool)) ||
        (statusFilter === "healthy" && isHealthy(pool))),
  );
  const hasActiveFilters =
    Boolean(search) || providerFilter !== "all" || statusFilter !== "all";
  const clearFilters = useCallback(
    () => updateQueryParams({ search: null, provider: null, status: null }),
    [updateQueryParams],
  );
  const providers = [
    ...new Set(pools.flatMap((pool) => pool.members.map((m) => m.provider))),
  ].sort();
  const editing = pools.find((pool) => pool.id === editingId) ?? null;
  const rangeSelection = useBulkRangeSelectionController();
  const cardSelection = useBulkCardSelection({
    rows: visible,
    getRowId: (pool) => pool.id,
    rowSelection,
    setRowSelection,
    rangeSelection,
  });
  // Only what the filters show, so a delete never takes a pool out of sight.
  const selected = visible.filter((pool) => rowSelection[pool.id]);

  const rowActions = (pool: ModelPool) => (
    <TableRowActions
      itemName={pool.name}
      actions={[
        {
          icon: <Plug className="h-4 w-4" />,
          label: "Connect",
          onClick: () => setConnecting({ pool, ready: false }),
        },
        {
          icon: <Pencil className="h-4 w-4" />,
          label: "Edit",
          permissions: { llmModel: ["update"] },
          onClick: () => setEditingId(pool.id),
        },
      ]}
      dropdownActions={[
        {
          icon: <Trash2 className="h-4 w-4" />,
          label: "Delete",
          permissions: { llmModel: ["update"] },
          variant: "destructive",
          onClick: () => setDeleting(pool),
        },
      ]}
    />
  );

  const columns: ColumnDef<ModelPool>[] = [
    createSelectColumn<ModelPool>({
      rowLabel: (row) => `Select ${row.name}`,
      allLabel: "Select all pools",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 240,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <PoolProviderIcons pool={row.original} />
          <div className="min-w-0">
            <div className="truncate font-mono font-medium">
              {row.original.name}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              <PoolProviders pool={row.original} />
            </div>
          </div>
        </div>
      ),
    },
    {
      id: "members",
      header: "Members",
      size: 140,
      cell: ({ row }) => (
        <span className="text-sm">{memberSummary(row.original)}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      size: 150,
      cell: ({ row }) => <PoolHealth pool={row.original} />,
    },
    {
      id: "actions",
      header: "Actions",
      cell: ({ row }) => rowActions(row.original),
    },
  ];

  const createButton = needsFirstProvider ? null : (
    <PermissionButton
      size="sm"
      permissions={{ llmModel: ["update"] }}
      onClick={() => setCreating(true)}
    >
      <Plus />
      <span>Create pool</span>
    </PermissionButton>
  );

  return (
    <PageLayout
      title="Model Pools"
      description={DESCRIPTION}
      actionButton={createButton}
    >
      {query.isLoadingError ? (
        <QueryLoadError
          title="Couldn't load your model pools"
          description={query.error?.message}
          onRetry={() => query.refetch()}
        />
      ) : needsFirstProvider ? (
        <EmptyState
          icon={Server}
          title="Connect your first model provider"
          description="A pool serves a model from shared provider keys. Add one, then create a pool."
          action={
            <PermissionButton
              size="sm"
              permissions={{ llmProviderApiKey: ["create"] }}
              onClick={() => setProviderDialogOpen(true)}
            >
              <Plus />
              <span>Add model provider</span>
            </PermissionButton>
          }
        />
      ) : (
        <TableCardView storageKey="archestra-llm-model-pools-view">
          <CollectionFilters>
            <FilterBar
              leading
              actions={<TableCardViewToggle />}
              onClearFilters={hasActiveFilters ? clearFilters : undefined}
              search={
                <SearchInput
                  objectNamePlural="pools"
                  searchFields={["name"]}
                  paramName="search"
                  className={filterSearchClass}
                />
              }
            >
              <FilterSelect
                value={providerFilter}
                onValueChange={(value) =>
                  updateQueryParams({
                    provider: value === "all" ? null : value,
                  })
                }
                placeholder="Filter by provider"
                showSearch={false}
                items={[
                  { value: "all", label: "All providers" },
                  ...providers.map((provider) => ({
                    value: provider,
                    label: providerCatalog.label(provider as SupportedProvider),
                  })),
                ]}
              />
              <FilterSelect
                value={statusFilter}
                onValueChange={(value) =>
                  updateQueryParams({ status: value === "all" ? null : value })
                }
                placeholder="Filter by status"
                showSearch={false}
                items={[
                  { value: "all", label: "Any status" },
                  { value: "benched", label: "Has members cooling down" },
                  { value: "healthy", label: "All healthy" },
                ]}
              />
            </FilterBar>
          </CollectionFilters>

          <BulkActions
            count={selected.length}
            noun="pool"
            onClear={clearSelection}
            busy={bulkDelete.isPending}
          >
            <PermissionButton
              permissions={{ llmModel: ["update"] }}
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
                itemCount={visible.length}
                isLoading={query.isLoading}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                emptyIcon={Layers}
                emptyMessage={EMPTY_MESSAGE}
                filteredEmptyMessage="No model pools match your filters"
              >
                {visible.map((pool) => (
                  <TableCard
                    key={pool.id}
                    icon={<PoolProviderIcons pool={pool} />}
                    title={<span className="font-mono">{pool.name}</span>}
                    description={<PoolProviders pool={pool} />}
                    onNavigate={() => setEditingId(pool.id)}
                    actions={rowActions(pool)}
                    footer={<PoolHealth pool={pool} />}
                    {...cardSelection(pool)}
                    selectionLabel={`Select ${pool.name}`}
                  >
                    <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Members</dt>
                      <dd className="min-w-0 truncate">
                        {memberSummary(pool)}
                      </dd>
                    </dl>
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                flexibleColumnIds={["name"]}
                fixedWidthColumnIds={["members", "status"]}
                // The name cell already lists the providers, so a narrow
                // window drops the member count first.
                columnDropOrder={["members"]}
                data={visible}
                getRowId={(row) => row.id}
                rowSelection={rowSelection}
                onRowSelectionChange={setRowSelection}
                rangeSelection={rangeSelection}
                hideSelectedCount
                onRowClick={(row) => setEditingId(row.id)}
                isLoading={query.isLoading}
                hasActiveFilters={hasActiveFilters}
                onClearFilters={clearFilters}
                emptyIcon={Layers}
                emptyMessage={EMPTY_MESSAGE}
                filteredEmptyMessage="No model pools match your filters."
              />
            }
          />
        </TableCardView>
      )}

      <CreateLlmProviderApiKeyDialog
        open={providerDialogOpen}
        onOpenChange={setProviderDialogOpen}
        title="Add model provider"
        description="Add a provider API key or a self-hosted endpoint"
        onSuccess={() => setCreating(true)}
      />
      {creating ? (
        <PoolDialog
          pool={null}
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
          onCreated={(pool) => {
            setCreating(false);
            setConnecting({ pool, ready: true });
          }}
        />
      ) : null}
      {editing ? (
        <PoolDialog
          key={editing.id}
          pool={editing}
          onOpenChange={(open) => {
            if (!open) setEditingId(null);
          }}
        />
      ) : null}
      {connecting ? (
        <ConnectPoolDialog
          key={connecting.pool.id}
          pool={connecting.pool}
          ready={connecting.ready}
          onOpenChange={(open) => {
            if (!open) setConnecting(null);
          }}
        />
      ) : null}
      <DeleteConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete model pool"
        description={`Delete "${deleting?.name}"? Requests for this name go back to the caller's own key.`}
        confirmLabel="Delete"
        isPending={deletePool.isPending}
        onConfirm={() => {
          if (!deleting) return;
          deletePool.mutate(deleting.id, {
            onSuccess: () => setDeleting(null),
          });
        }}
      />
      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete model pools"
        description={`Delete ${selected.length} ${
          selected.length === 1 ? "pool" : "pools"
        }? Requests for their names go back to the caller's own key.`}
        isPending={bulkDelete.isPending}
        onConfirm={() => {
          bulkDelete.mutate(selected, {
            onSuccess: (outcome) => {
              reportBulkOutcome({
                outcome,
                verb: "Deleted",
                failureVerb: "delete",
                noun: "pool",
              });
              setBulkDeleteOpen(false);
              // Pools that failed stay ticked so the delete can be retried.
              if (outcome.failed.length === 0) clearSelection();
            },
          });
        }}
        confirmLabel="Delete pools"
        pendingLabel="Deleting..."
      />
    </PageLayout>
  );
}

/** Every member that is on is answering, and at least one is on. */
function isHealthy(pool: ModelPool): boolean {
  return (
    pool.members.some((member) => member.enabled) && !hasBenchedMember(pool)
  );
}

function hasBenchedMember(pool: ModelPool): boolean {
  return pool.members.some(
    (member) =>
      member.enabled &&
      member.benchedUntil !== null &&
      new Date(member.benchedUntil).getTime() > Date.now(),
  );
}
