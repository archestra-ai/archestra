"use client";

import {
  type archestraApiTypes,
  LLM_PROXY_OAUTH_SCOPE,
} from "@archestra/shared";
import type { ColumnDef, RowSelectionState } from "@tanstack/react-table";
import { AppWindow, Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetLlmProxyAction } from "@/app/llm/proxy/_parts/llm-proxy-action-context";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { EditOAuthClientDialog } from "@/components/llm-oauth-client-dialogs";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import {
  isProviderApiKeyId,
  ProviderKeyFilterSelect,
} from "@/components/provider-key-filter-select";
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
import { PermissionButton } from "@/components/ui/permission-button";
import { useSession } from "@/lib/auth/auth.query";
import { reportBulkOutcome } from "@/lib/bulk-action";
import { copyToClipboard } from "@/lib/clipboard";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useBulkDeleteLlmOauthClients,
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
  useUpdateLlmOauthClient,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";

type OauthClientRow =
  archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"][number];
type GrantTypeFilter = NonNullable<
  NonNullable<archestraApiTypes.GetLlmOauthClientsData["query"]>["grantType"]
>;

export default function OauthClientsPage() {
  return (
    <ErrorBoundary>
      <OauthClientsTable />
    </ErrorBoundary>
  );
}

function OauthClientsTable() {
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
  const grantTypeFromUrl = searchParams.get("grantType");
  const grantTypeFilter = isGrantType(grantTypeFromUrl)
    ? grantTypeFromUrl
    : undefined;
  const providerApiKeyIdFromUrl = searchParams.get("providerApiKeyId");
  const providerApiKeyIdFilter = isProviderApiKeyId(providerApiKeyIdFromUrl)
    ? providerApiKeyIdFromUrl
    : undefined;

  const providerCatalog = useModelProviderCatalog();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();

  const query = useLlmOauthClients({
    limit: pageSize,
    offset,
    search: searchFromUrl || undefined,
    grantType: grantTypeFilter,
    providerApiKeyId: providerApiKeyIdFilter,
    toastOnError: false,
  });

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [createOpen, setCreateOpen] = useState(false);
  const [revealedCredentials, setRevealedCredentials] = useState<{
    title: string;
    credentials: CreatedCredentials;
  } | null>(null);
  const [editingClient, setEditingClient] = useState<OauthClientRow | null>(
    null,
  );
  const [rotatingClient, setRotatingClient] = useState<OauthClientRow | null>(
    null,
  );
  const [deletingClient, setDeletingClient] = useState<OauthClientRow | null>(
    null,
  );
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const createMutation = useCreateLlmOauthClient();
  const updateMutation = useUpdateLlmOauthClient();
  const rotateMutation = useRotateLlmOauthClientSecret();
  const deleteMutation = useDeleteLlmOauthClient();
  const bulkDelete = useBulkDeleteLlmOauthClients();

  const clearSelection = useCallback(() => setRowSelection({}), []);

  useEffect(() => {
    setActionButton(
      <PermissionButton
        permissions={{ llmOauthClient: ["create"] }}
        onClick={() => setCreateOpen(true)}
      >
        <Plus className="h-4 w-4" />
        <span>Create OAuth Client</span>
      </PermissionButton>,
    );
    return () => setActionButton(null);
  }, [setActionButton]);

  const clients = query.data?.data ?? [];
  const pagination = query.data?.pagination;
  const selectedClients = clients.filter((client) => rowSelection[client.id]);
  const hasActiveFilters = Boolean(
    searchFromUrl || grantTypeFilter || providerApiKeyIdFilter,
  );

  const clearFilters = useCallback(() => {
    updateQueryParams({
      search: null,
      grantType: null,
      providerApiKeyId: null,
      page: "1",
    });
  }, [updateQueryParams]);

  const columns: ColumnDef<OauthClientRow>[] = [
    createSelectColumn<OauthClientRow>({
      rowLabel: (row) => `Select ${row.name}`,
      allLabel: "Select all OAuth clients on this page",
    }),
    {
      id: "name",
      accessorKey: "name",
      header: "Name",
      size: 190,
      cell: ({ row }) => (
        <span className="block max-w-[190px] truncate font-medium">
          <span>{row.original.name}</span>
          {row.original.disabled && (
            <span className="ml-1.5 text-muted-foreground">(disabled)</span>
          )}
        </span>
      ),
    },
    {
      id: "clientId",
      header: "Client ID",
      size: 240,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 font-mono text-xs">
          <code className="max-w-[200px] truncate">
            {row.original.clientId}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy client ID for ${row.original.name}`}
            onClick={async () => {
              await copyToClipboard(row.original.clientId);
              toast.success("Client ID copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      ),
    },
    {
      id: "grantType",
      header: "Grant type",
      size: 160,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.grantType === "authorization_code" ? (
            <span>On behalf of users</span>
          ) : (
            <span>Application</span>
          )}
        </Badge>
      ),
    },
    {
      id: "providers",
      header: "Providers",
      size: 150,
      cell: ({ row }) => (
        <span className="block max-w-[150px] truncate text-muted-foreground">
          {row.original.providerApiKeys.length > 0 ? (
            <span>
              {[
                ...new Set(
                  row.original.providerApiKeys.map((mapping) =>
                    providerCatalog.label(mapping.provider),
                  ),
                ),
              ].join(", ")}
            </span>
          ) : (
            <span>—</span>
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
      id: "actions",
      header: "Actions",
      size: 130,
      cell: ({ row }) => (
        <TableRowActions
          itemName={row.original.name}
          actions={[
            {
              icon: <Pencil className="h-4 w-4" />,
              label: "Edit",
              permissions: { llmOauthClient: ["update"] },
              onClick: () => setEditingClient(row.original),
            },
            {
              icon: <RefreshCw className="h-4 w-4" />,
              label: "Rotate secret",
              permissions: { llmOauthClient: ["update"] },
              onClick: () => setRotatingClient(row.original),
            },
            {
              icon: <Trash2 className="h-4 w-4" />,
              label: "Delete",
              permissions: { llmOauthClient: ["delete"] },
              variant: "destructive",
              onClick: () => setDeletingClient(row.original),
            },
          ]}
        />
      ),
    },
  ];

  if (query.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load OAuth clients"
        onRetry={() => query.refetch()}
      />
    );
  }

  return (
    <TableCardView storageKey="archestra-llm-oauth-clients-view">
      <div>
        <div className="mb-3">
          <FilterBar actions={<TableCardViewToggle />}>
            <SearchInput
              objectNamePlural="OAuth clients"
              searchFields={["name"]}
              paramName="search"
              className={filterSearchClass}
            />
            <FilterSelect
              value={grantTypeFilter ?? "all"}
              onValueChange={(value) =>
                updateQueryParams({
                  grantType: value === "all" ? null : value,
                  page: "1",
                })
              }
              placeholder="Filter by grant type"
              items={[
                { value: "all", label: "All grant types" },
                { value: "client_credentials", label: "Application" },
                { value: "authorization_code", label: "On behalf of users" },
              ]}
            />
            <ProviderKeyFilterSelect
              value={providerApiKeyIdFilter}
              onValueChange={(providerApiKeyId) =>
                updateQueryParams({ providerApiKeyId, page: "1" })
              }
            />
          </FilterBar>
        </div>

        <BulkActions
          count={selectedClients.length}
          noun="client"
          onClear={clearSelection}
          busy={bulkDelete.isPending}
        >
          <PermissionButton
            permissions={{ llmOauthClient: ["delete"] }}
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
              itemCount={clients.length}
              isLoading={query.isFetching}
              hasActiveFilters={hasActiveFilters}
              onClearFilters={clearFilters}
              emptyIcon={AppWindow}
              emptyMessage="No OAuth clients yet. Register one for applications that authenticate with OAuth."
              filteredEmptyMessage="No OAuth clients match your filters"
              pagination={{
                pageIndex,
                pageSize,
                total: pagination?.total ?? 0,
              }}
              onPaginationChange={setPagination}
            >
              {clients.map((client) => (
                <TableCard
                  key={client.id}
                  icon={<AppWindow className="h-5 w-5" />}
                  title={
                    <span>
                      <span>{client.name}</span>
                      {client.disabled && (
                        <span className="ml-1.5 text-muted-foreground">
                          (disabled)
                        </span>
                      )}
                    </span>
                  }
                  selected={!!rowSelection[client.id]}
                  onSelectedChange={(selected) => {
                    setRowSelection((current) => {
                      const next = { ...current };
                      if (selected) next[client.id] = true;
                      else delete next[client.id];
                      return next;
                    });
                  }}
                  selectionLabel={`Select ${client.name}`}
                  actions={
                    <TableRowActions
                      itemName={client.name}
                      actions={[
                        {
                          icon: <Pencil className="h-4 w-4" />,
                          label: "Edit",
                          permissions: { llmOauthClient: ["update"] },
                          onClick: () => setEditingClient(client),
                        },
                        {
                          icon: <RefreshCw className="h-4 w-4" />,
                          label: "Rotate secret",
                          permissions: { llmOauthClient: ["update"] },
                          onClick: () => setRotatingClient(client),
                        },
                        {
                          icon: <Trash2 className="h-4 w-4" />,
                          label: "Delete",
                          permissions: { llmOauthClient: ["delete"] },
                          variant: "destructive",
                          onClick: () => setDeletingClient(client),
                        },
                      ]}
                    />
                  }
                >
                  <div className="space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {client.grantType === "authorization_code" ? (
                          <span>On behalf of users</span>
                        ) : (
                          <span>Application</span>
                        )}
                      </Badge>
                      <ResourceVisibilityBadge
                        scope={client.scope}
                        teams={client.teams}
                        authorId={client.authorId}
                        authorName={client.authorName}
                        currentUserId={currentUserId}
                        showSelfAsMe
                      />
                    </div>
                    {/* Client ID left, mapped providers in the row's spare width. */}
                    <div className="flex items-center justify-between gap-3">
                      <div className="flex min-w-0 items-center gap-1 font-mono text-xs">
                        <code className="min-w-0 truncate">
                          {client.clientId}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0"
                          aria-label={`Copy client ID for ${client.name}`}
                          onClick={async () => {
                            await copyToClipboard(client.clientId);
                            toast.success("Client ID copied");
                          }}
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                      {client.providerApiKeys.length > 0 && (
                        <p className="min-w-0 shrink truncate text-right text-xs text-muted-foreground">
                          {[
                            ...new Set(
                              client.providerApiKeys.map((mapping) =>
                                providerCatalog.label(mapping.provider),
                              ),
                            ),
                          ].join(", ")}
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
              data={clients}
              getRowId={(row) => row.id}
              rowSelection={rowSelection}
              onRowSelectionChange={setRowSelection}
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
              emptyMessage="No OAuth clients yet. Register one for applications that authenticate with OAuth."
              filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
            />
          }
        />

        <CreateOAuthClientDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          defaultClientType="llm"
          fixedClientType="llm"
          gateways={[]}
          providerApiKeys={providerApiKeys}
          onSubmit={async (values) => {
            if (values.kind !== "llm") return;
            const result = await createMutation.mutateAsync(values.body);
            if (result) {
              setRevealedCredentials({
                title: "OAuth Client Created",
                credentials: {
                  clientId: result.clientId,
                  clientSecret: result.clientSecret,
                  grantType: result.grantType,
                  oauthScope: LLM_PROXY_OAUTH_SCOPE,
                },
              });
              setCreateOpen(false);
            }
          }}
          isSubmitting={createMutation.isPending}
        />
        <OAuthClientCreatedDialog
          open={!!revealedCredentials}
          onOpenChange={(open) => {
            if (!open) setRevealedCredentials(null);
          }}
          title={revealedCredentials?.title ?? "OAuth Client Created"}
          credentials={revealedCredentials?.credentials ?? null}
        />

        <EditOAuthClientDialog
          oauthClient={editingClient}
          onOpenChange={(open) => {
            if (!open) setEditingClient(null);
          }}
          providerApiKeys={providerApiKeys}
          onSubmit={async (id, body) => {
            if (await updateMutation.mutateAsync({ id, body }))
              setEditingClient(null);
          }}
          isSubmitting={updateMutation.isPending}
        />

        <DeleteConfirmDialog
          open={!!rotatingClient}
          onOpenChange={(open) => {
            if (!open) setRotatingClient(null);
          }}
          title="Rotate Client Secret"
          description={`Rotate the secret for "${rotatingClient?.name}"? The current secret stops working immediately; the new one is shown once.`}
          confirmLabel="Rotate"
          isPending={rotateMutation.isPending}
          onConfirm={async () => {
            if (!rotatingClient) return;
            const result = await rotateMutation.mutateAsync({
              id: rotatingClient.id,
            });
            if (result) {
              setRevealedCredentials({
                title: "Client Secret Rotated",
                credentials: {
                  clientId: result.clientId,
                  clientSecret: result.clientSecret,
                  grantType: result.grantType,
                  oauthScope: LLM_PROXY_OAUTH_SCOPE,
                },
              });
            }
            setRotatingClient(null);
          }}
        />

        <DeleteConfirmDialog
          open={!!deletingClient}
          onOpenChange={(open) => {
            if (!open) setDeletingClient(null);
          }}
          title="Delete OAuth Client"
          description={`Are you sure you want to delete "${deletingClient?.name}"? Applications using it will stop authenticating. This action cannot be undone.`}
          confirmLabel="Delete"
          isPending={deleteMutation.isPending}
          onConfirm={() => {
            if (!deletingClient) return;
            deleteMutation.mutate(
              { id: deletingClient.id },
              { onSuccess: () => setDeletingClient(null) },
            );
          }}
        />
        {bulkDeleteOpen && (
          <DeleteConfirmDialog
            open={bulkDeleteOpen}
            onOpenChange={setBulkDeleteOpen}
            title="Delete OAuth clients"
            description={`Delete ${selectedClients.length} ${
              selectedClients.length === 1 ? "client" : "clients"
            }? Applications using them stop authenticating. This cannot be undone.`}
            isPending={bulkDelete.isPending}
            onConfirm={() => {
              bulkDelete.mutate(selectedClients, {
                onSuccess: (outcome) => {
                  reportBulkOutcome({
                    outcome,
                    verb: "Deleted",
                    failureVerb: "delete",
                    noun: "client",
                  });
                  setBulkDeleteOpen(false);
                  // Rows that failed stay ticked so the selection can be
                  // retried rather than rebuilt.
                  if (outcome.failed.length === 0) clearSelection();
                },
              });
            }}
            confirmLabel="Delete clients"
            pendingLabel="Deleting..."
          />
        )}
      </div>
    </TableCardView>
  );
}

function isGrantType(value: string | null): value is GrantTypeFilter {
  return value === "client_credentials" || value === "authorization_code";
}
