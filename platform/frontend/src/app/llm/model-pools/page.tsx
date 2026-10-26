"use client";

import { isModelPoolProvider, type SupportedProvider } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Layers, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { notFound } from "next/navigation";
import { useCallback, useState } from "react";
import { CreateLlmProviderApiKeyDialog } from "@/components/create-llm-provider-api-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EmptyState } from "@/components/empty-state";
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
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useFeature } from "@/lib/config/config.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  type ModelPool,
  useDeleteModelPool,
  useModelPools,
} from "@/lib/model-pools.query";
import { CreatePoolDialog } from "./_parts/create-pool-dialog";
import { EditPoolDialog } from "./_parts/edit-pool-dialog";
import { PoolHealth } from "./_parts/member-status";
import { PoolProviders } from "./_parts/pool-fields";
import { accessSummary, memberSummary } from "./_parts/pool-form";

const DESCRIPTION =
  "Serve one model from several provider keys, on one provider or several. Clients ask for the pool's name; requests go to the lowest order first, split by weight, and to the next order on rate limits and outages.";

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
  const [deleting, setDeleting] = useState<ModelPool | null>(null);
  const [providerDialogOpen, setProviderDialogOpen] = useState(false);
  const deletePool = useDeleteModelPool();
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

  const rowActions = (pool: ModelPool) => (
    <TableRowActions
      itemName={pool.name}
      actions={[
        {
          icon: <Pencil className="h-4 w-4" />,
          label: "Edit",
          permissions: { llmModel: ["update"] },
          onClick: () => setEditingId(pool.id),
        },
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
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 240,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <PoolIcon />
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
      size: 180,
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
      id: "access",
      header: "Access",
      size: 140,
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {accessSummary(row.original.virtualApiKeyIds.length)}
        </span>
      ),
    },
    {
      id: "actions",
      header: "Actions",
      size: 100,
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
                  { value: "benched", label: "Has benched members" },
                  { value: "healthy", label: "All healthy" },
                ]}
              />
            </FilterBar>
          </CollectionFilters>

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
                    icon={<PoolIcon />}
                    title={<span className="font-mono">{pool.name}</span>}
                    description={<PoolProviders pool={pool} />}
                    onNavigate={() => setEditingId(pool.id)}
                    actions={rowActions(pool)}
                    footer={<PoolHealth pool={pool} />}
                  >
                    <dl className="grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Members</dt>
                      <dd className="min-w-0 truncate">
                        {memberSummary(pool)}
                      </dd>
                      <dt className="text-muted-foreground">Routing</dt>
                      <dd className="min-w-0 truncate">
                        Priority, then weight
                      </dd>
                      <dt className="text-muted-foreground">Access</dt>
                      <dd className="min-w-0 truncate">
                        {accessSummary(pool.virtualApiKeyIds.length)}
                      </dd>
                    </dl>
                  </TableCard>
                ))}
              </TableCardList>
            }
            table={
              <DataTable
                columns={columns}
                data={visible}
                getRowId={(row) => row.id}
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
        <CreatePoolDialog
          onOpenChange={(open) => {
            if (!open) setCreating(false);
          }}
        />
      ) : null}
      {editing ? (
        <EditPoolDialog
          key={editing.id}
          pool={editing}
          onOpenChange={(open) => {
            if (!open) setEditingId(null);
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
    </PageLayout>
  );
}

function PoolIcon() {
  return (
    <span
      aria-hidden="true"
      className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/15 text-primary"
    >
      <Layers className="size-3.5" />
    </span>
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
