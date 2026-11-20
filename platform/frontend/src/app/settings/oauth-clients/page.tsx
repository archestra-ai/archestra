"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetSettingsAction } from "@/app/settings/layout";
import { AgentNameCell } from "@/components/agent-name-cell";
import { openRowOnPlainClick } from "@/components/agent-pages/row-click-shield";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { OAuthClientApis } from "@/components/oauth-client/apis";
import { oauthCapabilities } from "@/components/oauth-client/configuration-fields";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { OAuthClientPermissions } from "@/components/oauth-client-permissions";
import { QueryLoadError } from "@/components/query-load-error";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { useScopeFilterParams } from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { BulkActions } from "@/components/ui/bulk-actions-bar";
import { BulkActionsScope } from "@/components/ui/bulk-actions-context";
import { createSelectColumn } from "@/components/ui/bulk-select-column";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { reportBulkOutcome } from "@/lib/bulk-action";
import {
  useOauthClientLabelKeys,
  useOauthClientLabelValues,
} from "@/lib/entity-labels.query";
import { useBulkSelection } from "@/lib/hooks/use-bulk-selection";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import {
  useBulkDeleteOauthClients,
  useDeleteOauthClient,
  useOauthClients,
  useRotateOauthClientSecret,
} from "@/lib/oauth-clients.query";
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

type Client = archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];

export default function OauthClientsPage() {
  return (
    <ErrorBoundary>
      <OauthClientsList />
    </ErrorBoundary>
  );
}

// === Internal helpers

/**
 * The organization's OAuth clients, laid out like the service accounts list:
 * filters, then a table whose rows open the client's own page. Creating one
 * is a page of its own, as is editing one.
 */
function OauthClientsList() {
  const router = useRouter();
  const setActionButton = useSetSettingsAction();
  const {
    searchParams,
    updateQueryParams,
    pageIndex,
    pageSize,
    offset,
    setPagination,
  } = useDataTableQueryParams();
  const search = searchParams.get("search") ?? "";
  const labels = searchParams.get("labels") || undefined;
  const providerApiKeyId = searchParams.get("providerApiKeyId") || undefined;
  const capability = oauthCapabilities.find(
    (item) => item.scope === searchParams.get("capability"),
  )?.scope;
  const grantTypeParam = searchParams.get("grantType");
  const grantType =
    grantTypeParam === "client_credentials" ||
    grantTypeParam === "authorization_code"
      ? grantTypeParam
      : undefined;
  const { access, sharedWith, owner, hasActiveScopeFilters } =
    useScopeFilterParams();
  const query = useOauthClients({
    limit: Math.min(pageSize, 100),
    offset,
    search: search || undefined,
    capability,
    labels,
    providerApiKeyId,
    grantType,
    access,
    sharedWith,
    owner,
    toastOnError: false,
  });
  const clients = query.data?.data ?? [];
  const rotate = useRotateOauthClientSecret();
  const remove = useDeleteOauthClient();
  const bulkDelete = useBulkDeleteOauthClients();
  const [rotating, setRotating] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [revealed, setRevealed] = useState<CreatedCredentials | null>(null);
  const filtered = Boolean(
    search ||
      labels ||
      providerApiKeyId ||
      capability ||
      grantType ||
      hasActiveScopeFilters,
  );
  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        search: null,
        labels: null,
        providerApiKeyId: null,
        capability: null,
        grantType: null,
        type: null,
        ...Object.fromEntries(
          RESOURCE_ACCESS_FILTER_PARAMS.map((param) => [param, null]),
        ),
        page: "1",
      }),
    [updateQueryParams],
  );

  const {
    rowSelection,
    setRowSelection,
    onPageRowIdsChange,
    clearSelection,
    selected,
  } = useBulkSelection({
    rows: clients,
    getId: (client) => client.id,
    filterSignature: searchParams.toString(),
  });

  useEffect(() => {
    setActionButton(
      <div className="flex items-center gap-2">
        <PermissionButton
          permissions={{ oauthClient: ["create"] }}
          size="sm"
          onClick={() => router.push("/settings/oauth-clients/new")}
        >
          <Plus className="size-4" />
          <span>Create OAuth Client</span>
        </PermissionButton>
        <OAuthClientPermissions />
      </div>,
    );
    return () => setActionButton(null);
  }, [setActionButton, router]);

  // `DataTable` sets the table's `minWidth` to the sum of these sizes, so the
  // sum has to fit the settings shell's content column (~718px at 1200px
  // wide), as on the service accounts list.
  const columns: ColumnDef<Client>[] = useMemo(
    () => [
      createSelectColumn<Client>({
        rowLabel: (client) => `Select ${client.name}`,
        allLabel: "Select all OAuth clients on this page",
      }),
      {
        accessorKey: "name",
        header: "Application",
        size: 200,
        cell: ({ row }) => (
          <AgentNameCell
            name={row.original.name}
            icon={<SignInIcon client={row.original} />}
            labels={row.original.labels}
            description={
              row.original.grantType === "authorization_code"
                ? "For its users"
                : "As itself"
            }
            href={`/settings/oauth-clients/${row.original.id}`}
            underlineOnHover={false}
            extraBadges={
              row.original.disabled ? (
                <Badge variant="secondary">Disabled</Badge>
              ) : undefined
            }
          />
        ),
      },
      {
        id: "apis",
        header: "APIs",
        size: 240,
        cell: ({ row }) => <OAuthClientApis scopes={row.original.scopes} />,
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        size: 110,
        cell: ({ row }) => (
          <span title={new Date(row.original.createdAt).toLocaleString()}>
            {formatRelativeTimeFromNow(row.original.createdAt)}
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
            permissionScope={row.original.id}
            actions={[
              {
                icon: <Pencil className="size-4" />,
                label: "Edit",
                permissions: { oauthClient: ["update"] },
                // The edit page's back link returns here, not to the
                // client's page, when it was opened from the list.
                onClick: () =>
                  router.push(
                    `/settings/oauth-clients/${row.original.id}/edit?from=list`,
                  ),
              },
            ]}
            dropdownActions={[
              {
                icon: <RefreshCw className="size-4" />,
                label: "Rotate secret",
                permissions: { oauthClient: ["update"] },
                onClick: () => setRotating(row.original),
              },
              {
                icon: <Trash2 className="size-4" />,
                label: "Delete",
                permissions: { oauthClient: ["delete"] },
                variant: "destructive",
                onClick: () => setDeleting(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [router],
  );

  if (query.isLoadingError)
    return (
      <QueryLoadError
        title="Couldn't load OAuth clients"
        error={query.error}
        onRetry={() => query.refetch()}
      />
    );

  return (
    <BulkActionsScope>
      <div>
        <CollectionFilters>
          <FilterBar
            onClearFilters={filtered ? clearFilters : undefined}
            search={
              <SearchInput
                value={search}
                onSearchChange={(value) =>
                  updateQueryParams({ search: value || null, page: "1" })
                }
                placeholder="Search OAuth clients by name"
                className={filterSearchClass}
              />
            }
          >
            <ResourceAccessFilter resource="oauthClient" noun="OAuth clients" />
            <FilterSelect
              value={capability ?? "all"}
              onValueChange={(value) =>
                updateQueryParams({
                  capability: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by API access"
              showSearch={false}
              items={[
                { value: "all", label: "All APIs" },
                ...oauthCapabilities.map(({ scope, label, icon: Icon }) => ({
                  value: scope,
                  label,
                  content: (
                    <span className="flex items-center gap-2">
                      <Icon className="size-4 shrink-0" />
                      <span>{label}</span>
                    </span>
                  ),
                })),
              ]}
            />
            <FilterSelect
              value={grantType ?? "all"}
              onValueChange={(value) =>
                updateQueryParams({
                  grantType: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by how it signs in"
              showSearch={false}
              items={[
                { value: "all", label: "All sign-in modes" },
                {
                  value: "client_credentials",
                  label: "As itself",
                  content: (
                    <span className="flex items-center gap-2">
                      <Server className="size-4 shrink-0" />
                      <span>As itself</span>
                    </span>
                  ),
                },
                {
                  value: "authorization_code",
                  label: "For its users",
                  content: (
                    <span className="flex items-center gap-2">
                      <Users className="size-4 shrink-0" />
                      <span>For its users</span>
                    </span>
                  ),
                },
              ]}
            />
            <EntityLabelFilter
              useLabelKeys={useOauthClientLabelKeys}
              useLabelValues={useOauthClientLabelValues}
              className={filterControlClass({ active: Boolean(labels) })}
            />
          </FilterBar>
        </CollectionFilters>
        <BulkActions
          count={selected.length}
          noun="OAuth client"
          onClear={clearSelection}
          busy={bulkDelete.isPending}
        >
          <PermissionButton
            permissions={{ oauthClient: ["delete"] }}
            variant="destructive"
            size="sm"
            onClick={() => setBulkDeleteOpen(true)}
          >
            <Trash2 className="size-4" />
            <span>Delete</span>
          </PermissionButton>
        </BulkActions>
        <DataTable
          columns={columns}
          data={clients}
          getRowId={(row) => row.id}
          isLoading={query.isPending}
          manualPagination
          pagination={{
            pageIndex,
            pageSize,
            total: query.data?.pagination.total ?? 0,
          }}
          onPaginationChange={setPagination}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onPageRowIdsChange={onPageRowIdsChange}
          hideSelectedCount
          onRowClick={(client, event) =>
            openRowOnPlainClick(event, () =>
              router.push(`/settings/oauth-clients/${client.id}`),
            )
          }
          emptyIcon={KeyRound}
          emptyMessage="No OAuth clients yet"
          emptyDescription="Register one for an application that authenticates with OAuth."
          hasActiveFilters={filtered}
          filteredEmptyMessage="No OAuth clients match your filters"
          onClearFilters={clearFilters}
          hidePaginationWhenSinglePage
          fixedWidthColumnIds={["apis", "createdAt", "actions"]}
          flexibleColumnIds={["name"]}
        />
      </div>
      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title="Client Secret Rotated"
        credentials={revealed}
      />
      <DeleteConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate Client Secret"
        description={`Rotate the secret for "${rotating?.name}"? The current secret stops working immediately; the new one is shown once.`}
        confirmLabel="Rotate"
        isPending={rotate.isPending}
        onConfirm={async () => {
          if (!rotating) return;
          const client = await rotate.mutateAsync({ id: rotating.id });
          if (client)
            setRevealed({ ...client, oauthScope: client.scopes.join(" ") });
          setRotating(null);
        }}
      />
      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete OAuth Client"
        description={`Delete "${deleting?.name}"? Applications using it will stop authenticating. This action cannot be undone.`}
        confirmLabel="Delete"
        isPending={remove.isPending}
        onConfirm={async () => {
          if (deleting && (await remove.mutateAsync({ id: deleting.id })))
            setDeleting(null);
        }}
      />
      <DeleteConfirmDialog
        open={bulkDeleteOpen}
        onOpenChange={setBulkDeleteOpen}
        title="Delete OAuth clients"
        description={`Delete ${selected.length} ${
          selected.length === 1 ? "OAuth client" : "OAuth clients"
        }? Applications using them will stop authenticating.`}
        isPending={bulkDelete.isPending}
        onConfirm={() =>
          bulkDelete.mutate(selected, {
            onSuccess: (outcome) => {
              reportBulkOutcome({
                outcome,
                verb: "Deleted",
                failureVerb: "delete",
                noun: "OAuth client",
              });
              setBulkDeleteOpen(false);
              if (outcome.failed.length === 0) clearSelection();
            },
          })
        }
        confirmLabel="Delete"
        pendingLabel="Deleting..."
      />
    </BulkActionsScope>
  );
}

function SignInIcon({ client }: { client: Client }) {
  const Icon = client.grantType === "authorization_code" ? Users : Server;
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
      <Icon className="size-3.5" />
    </span>
  );
}
