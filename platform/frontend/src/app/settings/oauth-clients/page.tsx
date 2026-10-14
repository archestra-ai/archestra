"use client";

import type { archestraApiTypes } from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Copy,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetSettingsAction } from "@/app/settings/layout";
import { CreateManagedOAuthClientDialog } from "@/components/create-managed-oauth-client-dialog";
import { formatSpendCap } from "@/components/credential-billing/budget-fields";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EditManagedOAuthClientDialog } from "@/components/edit-managed-oauth-client-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LabelTags } from "@/components/label-tags";
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
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useProfiles } from "@/lib/agent.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useOauthClientLabelKeys,
  useOauthClientLabelValues,
} from "@/lib/entity-labels.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useCreateOauthClient,
  useDeleteOauthClient,
  useOauthClients,
  useRotateOauthClientSecret,
  useUpdateOauthClient,
} from "@/lib/oauth-clients.query";

type Client = archestraApiTypes.GetOauthClientsResponses["200"]["data"][number];
export default function OauthClientsPage() {
  return (
    <ErrorBoundary>
      <OauthClientsTable />
    </ErrorBoundary>
  );
}

function OauthClientsTable() {
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
  const labels = searchParams.get("labels") ?? undefined;
  const providerApiKeyId = searchParams.get("providerApiKeyId") ?? undefined;
  const capability = oauthCapabilities.find(
    (item) => item.scope === searchParams.get("capability"),
  )?.scope;
  const grantParam = searchParams.get("grantType");
  const grantType =
    grantParam === "client_credentials" || grantParam === "authorization_code"
      ? grantParam
      : undefined;
  const { hasActiveScopeFilters, access, sharedWith, owner } =
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
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const create = useCreateOauthClient();
  const update = useUpdateOauthClient();
  const rotate = useRotateOauthClientSecret();
  const remove = useDeleteOauthClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [rotating, setRotating] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [revealed, setRevealed] = useState<{
    title: string;
    credentials: CreatedCredentials;
  } | null>(null);
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
  useEffect(() => {
    setActionButton(
      <div className="flex items-center gap-2">
        <PermissionButton
          permissions={{ oauthClient: ["create"] }}
          size="sm"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" />
          <span>Create OAuth Client</span>
        </PermissionButton>
        <OAuthClientPermissions />
      </div>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);
  const columns: ColumnDef<Client>[] = [
    {
      id: "name",
      header: "Name",
      size: 220,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 font-medium">
            <span className="truncate">{row.original.name}</span>
            {row.original.disabled && (
              <Badge variant="secondary">Disabled</Badge>
            )}
            <LabelTags labels={row.original.labels} />
          </div>
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <code className="max-w-[160px] truncate">
              {row.original.clientId}
            </code>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Copy client ID for ${row.original.name}`}
              onClick={async (event) => {
                event.stopPropagation();
                await copyToClipboard(row.original.clientId);
                toast.success("Client ID copied");
              }}
            >
              <Copy className="size-3" />
            </Button>
          </div>
        </div>
      ),
    },
    {
      id: "scopes",
      header: "APIs",
      size: 250,
      cell: ({ row }) => (
        <div className="flex flex-wrap gap-1.5">
          {oauthCapabilities
            .filter((capability) =>
              row.original.scopes.includes(capability.scope),
            )
            .map(({ scope, label, icon: Icon }) => (
              <Badge key={scope} variant="outline">
                <Icon className="size-3" />
                <span>{label}</span>
              </Badge>
            ))}
        </div>
      ),
    },
    {
      id: "grantType",
      header: "Signs in",
      size: 150,
      cell: ({ row }) => {
        const user = row.original.grantType === "authorization_code";
        const Icon = user ? Users : Server;
        return (
          <div className="space-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Icon className="size-3.5" />
              <span>{user ? "For its users" : "As itself"}</span>
            </span>
            {row.original.serviceAccountId && (
              <span className="block text-xs">Service account linked</span>
            )}
          </div>
        );
      },
    },
    {
      id: "access",
      header: "Access",
      size: 230,
      cell: ({ row }) => {
        const client = row.original;
        const user = client.grantType === "authorization_code";
        const llm = client.scopes.includes("llm:proxy");
        const targets = client.allowedGatewayIds.length;
        const keys = client.providerApiKeys.length;
        return (
          <div className="space-y-1 text-sm">
            {user && <span className="block">Each user's access</span>}
            {targets > 0 && (
              <span className="block">
                {targets} {user ? "additional" : "allowed"}{" "}
                {targets === 1 ? "target" : "targets"}
              </span>
            )}
            {llm && !user && (
              <span className="block">
                {keys} provider {keys === 1 ? "key" : "keys"}
              </span>
            )}
            {llm && (client.billingTeam || client.spendCap) && (
              <div className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                {client.billingTeam && <span>{client.billingTeam.name}</span>}
                {client.spendCap && (
                  <span>{formatSpendCap(client.spendCap)} cap</span>
                )}
              </div>
            )}
          </div>
        );
      },
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
              onClick: () => setEditing(row.original),
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
  ];
  if (query.isLoadingError)
    return (
      <QueryLoadError
        title="Couldn't load OAuth clients"
        onRetry={() => query.refetch()}
      />
    );
  const showCredentials = (
    client: NonNullable<Awaited<ReturnType<typeof create.mutateAsync>>>,
    title: string,
  ) =>
    setRevealed({
      title,
      credentials: { ...client, oauthScope: client.scopes.join(" ") },
    });
  return (
    <div className="space-y-4">
      <CollectionFilters>
        <FilterBar onClearFilters={filtered ? clearFilters : undefined}>
          <SearchInput
            value={search}
            onSearchChange={(value) =>
              updateQueryParams({ search: value || null, page: "1" })
            }
            placeholder="Search OAuth clients by name"
            className={filterSearchClass}
          />
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
              ...oauthCapabilities.map(({ scope, label }) => ({
                value: scope,
                label,
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
              { value: "client_credentials", label: "As itself" },
              { value: "authorization_code", label: "For its users" },
            ]}
          />
          <EntityLabelFilter
            useLabelKeys={useOauthClientLabelKeys}
            useLabelValues={useOauthClientLabelValues}
            className={filterControlClass({ active: Boolean(labels) })}
          />
        </FilterBar>
      </CollectionFilters>
      <DataTable
        manualPagination
        pagination={{
          pageIndex,
          pageSize,
          total: query.data?.pagination.total ?? 0,
        }}
        onPaginationChange={setPagination}
        columns={columns}
        data={query.data?.data ?? []}
        getRowId={(client) => client.id}
        onRowClick={setEditing}
        isLoading={query.isPending}
        hasActiveFilters={filtered}
        onClearFilters={clearFilters}
        emptyMessage="No OAuth clients yet. Register one for an application that authenticates with OAuth."
        filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
      />
      <CreateManagedOAuthClientDialog
        open={creating}
        onOpenChange={setCreating}
        gateways={gateways}
        providerApiKeys={providerApiKeys}
        isSubmitting={create.isPending}
        onSubmit={async (body) => {
          const client = await create.mutateAsync(body);
          if (client) {
            showCredentials(client, "OAuth Client Created");
            setCreating(false);
          }
        }}
      />
      <EditManagedOAuthClientDialog
        oauthClient={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        gateways={gateways}
        providerApiKeys={providerApiKeys}
        isSubmitting={update.isPending}
        onSubmit={async (id, body) => {
          if (await update.mutateAsync({ id, body })) setEditing(null);
        }}
        onRotateSecret={(client) => {
          setEditing(null);
          setRotating(client);
        }}
      />
      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title={revealed?.title ?? "OAuth Client Created"}
        credentials={revealed?.credentials ?? null}
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
          if (client) showCredentials(client, "Client Secret Rotated");
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
    </div>
  );
}
