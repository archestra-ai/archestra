"use client";

import type { archestraApiTypes } from "@archestra/shared";
import { Plus, Server, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetSettingsAction } from "@/app/settings/layout";
import { CreateManagedOAuthClientDialog } from "@/components/create-managed-oauth-client-dialog";
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
import { oauthCapabilities } from "@/components/oauth-client/configuration-fields";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { OAuthClientPermissions } from "@/components/oauth-client-permissions";
import { OAuthClientsTable } from "@/components/oauth-clients-table";
import { QueryLoadError } from "@/components/query-load-error";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { useScopeFilterParams } from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import { PermissionButton } from "@/components/ui/permission-button";
import { useAgentOptions } from "@/lib/agent.query";
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
  const { data: gateways = [] } = useAgentOptions({
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
  if (query.isLoadingError)
    return (
      <QueryLoadError
        title="Couldn't load OAuth clients"
        error={query.error}
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
      <OAuthClientsTable
        pagination={{
          pageIndex,
          pageSize,
          total: query.data?.pagination.total ?? 0,
        }}
        onPaginationChange={setPagination}
        clients={query.data?.data ?? []}
        gateways={gateways}
        onEdit={setEditing}
        onRotate={setRotating}
        onDelete={setDeleting}
        isLoading={query.isPending}
        hasActiveFilters={filtered}
        onClearFilters={clearFilters}
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
