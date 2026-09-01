"use client";

import {
  type archestraApiTypes,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ErrorBoundary } from "@/app/_parts/error-boundary";
import { useSetSettingsAction } from "@/app/settings/layout";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterSearchClass,
} from "@/components/filter-bar";
import { EditOAuthClientDialog as EditLlmOAuthClientDialog } from "@/components/llm-oauth-client-dialogs";
import { EditOAuthClientDialog as EditMcpOAuthClientDialog } from "@/components/mcp-oauth-client-dialogs";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import { ALL_MATCHING_PAGE_SIZE } from "@/lib/hooks/use-all-matching";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
  useUpdateLlmOauthClient,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import {
  useCreateMcpOauthClient,
  useDeleteMcpOauthClient,
  useMcpOauthClients,
  useRotateMcpOauthClientSecret,
  useUpdateMcpOauthClient,
} from "@/lib/mcp-oauth-clients.query";

type LlmClient =
  archestraApiTypes.GetLlmOauthClientsResponses["200"]["data"][number];
type McpClient = archestraApiTypes.GetMcpOauthClientsResponses["200"][number];

/**
 * One row of the unified table. The two kinds share everything the table
 * needs by name; `kind` decides which mutation and which edit dialog a row
 * action reaches for, and which of `llm`/`mcp` carries the extra fields.
 */
type Row =
  | { kind: "llm"; client: LlmClient }
  | { kind: "mcp"; client: McpClient };

/**
 * The one place every OAuth client is managed, whatever it authenticates to.
 * They used to live on two pages — one under the LLM Proxy's tab bar, one
 * reachable only from an MCP gateway's Connect dialog — which meant the
 * reader had to know which product a credential belonged to before they could
 * find it, and the MCP half was filed under a dialog for wiring up Claude and
 * Cursor, an audience that never registers one.
 */
export default function OauthClientsPage() {
  return (
    <ErrorBoundary>
      <OauthClientsTable />
    </ErrorBoundary>
  );
}

// The LLM endpoint uses the shared pagination schema, so requesting more than
// its per-page ceiling rejects the whole page. Use the shared ceiling while
// the unified list still merges two endpoints without a common cursor.
const ALL_CLIENTS_LIMIT = ALL_MATCHING_PAGE_SIZE;

function OauthClientsTable() {
  const setActionButton = useSetSettingsAction();
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  const typeFilter = isClientType(searchParams.get("type"))
    ? (searchParams.get("type") as "llm" | "mcp")
    : undefined;
  const grantTypeFilter = isGrantType(searchParams.get("grantType"))
    ? (searchParams.get("grantType") as GrantType)
    : undefined;
  // Deep link from a provider key on Model Providers. It only means anything
  // to an LLM client, so it narrows the list to those on its own.
  const providerApiKeyId = searchParams.get("providerApiKeyId") || undefined;

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const providerCatalog = useModelProviderCatalog();
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const { data: resources = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const resourceNameById = new Map(resources.map((r) => [r.id, r.name]));

  const llmQuery = useLlmOauthClients({
    limit: ALL_CLIENTS_LIMIT,
    search: search || undefined,
    providerApiKeyId,
    toastOnError: false,
  });
  // Read permission for the two halves is separate, and only the LLM one
  // gates the route — so ask for MCP clients only when this reader may see
  // them, rather than showing them a failed request.
  const { data: canReadMcp } = useHasPermissions({ mcpOauthClient: ["read"] });
  const mcpQuery = useMcpOauthClients({
    search: search || undefined,
    enabled: canReadMcp === true,
  });

  const llmCreate = useCreateLlmOauthClient();
  const llmUpdate = useUpdateLlmOauthClient();
  const llmRotate = useRotateLlmOauthClientSecret();
  const llmDelete = useDeleteLlmOauthClient();
  const mcpCreate = useCreateMcpOauthClient();
  const mcpUpdate = useUpdateMcpOauthClient();
  const mcpRotate = useRotateMcpOauthClientSecret();
  const mcpDelete = useDeleteMcpOauthClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [editingLlm, setEditingLlm] = useState<LlmClient | null>(null);
  const [editingMcp, setEditingMcp] = useState<McpClient | null>(null);
  const [rotating, setRotating] = useState<Row | null>(null);
  const [deleting, setDeleting] = useState<Row | null>(null);
  const [revealed, setRevealed] = useState<{
    title: string;
    credentials: CreatedCredentials;
  } | null>(null);

  const rows: Row[] = [
    ...(llmQuery.data?.data ?? []).map(
      (client) => ({ kind: "llm", client }) as const,
    ),
    ...(mcpQuery.data ?? []).map(
      (client) => ({ kind: "mcp", client }) as const,
    ),
  ]
    .filter((row) => !typeFilter || row.kind === typeFilter)
    .filter((row) => !providerApiKeyId || row.kind === "llm")
    .filter(
      (row) => !grantTypeFilter || row.client.grantType === grantTypeFilter,
    )
    .sort((a, b) => a.client.name.localeCompare(b.client.name));

  const hasActiveFilters = Boolean(
    search || typeFilter || grantTypeFilter || providerApiKeyId,
  );
  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        search: null,
        type: null,
        grantType: null,
        providerApiKeyId: null,
        page: "1",
      }),
    [updateQueryParams],
  );

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

  /** What each client reaches: provider keys for LLM, gateways for MCP. */
  const describeAccess = (row: Row) => {
    if (row.kind === "llm") {
      const providers = [
        ...new Set(
          row.client.providerApiKeys.map((mapping) =>
            providerCatalog.label(mapping.provider),
          ),
        ),
      ];
      return providers.length > 0 ? providers.join(", ") : "—";
    }
    return row.client.allowedGatewayIds.length > 0
      ? row.client.allowedGatewayIds
          .map((id) => resourceNameById.get(id) ?? id)
          .join(", ")
      : "—";
  };

  const columns: ColumnDef<Row>[] = [
    {
      id: "name",
      header: "Name",
      size: 140,
      cell: ({ row }) => (
        <span className="block max-w-[140px] truncate font-medium">
          <span>{row.original.client.name}</span>
          {row.original.client.disabled && (
            <span className="ml-1.5 text-muted-foreground">(disabled)</span>
          )}
        </span>
      ),
    },
    {
      // The kind and the resources it reaches are one fact, and the settings
      // column is too narrow to spend two columns saying it.
      id: "type",
      header: "Authenticates to",
      size: 170,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-1">
          <Badge variant="secondary">
            {row.original.kind === "llm" ? (
              <span>LLM Proxy</span>
            ) : (
              <span>MCP</span>
            )}
          </Badge>
          <p className="max-w-[170px] truncate text-xs text-muted-foreground">
            {describeAccess(row.original)}
          </p>
        </div>
      ),
    },
    {
      id: "clientId",
      header: "Client ID",
      size: 140,
      cell: ({ row }) => (
        <div className="flex items-center gap-1 font-mono text-xs">
          <code className="max-w-[120px] truncate">
            {row.original.client.clientId}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Copy client ID for ${row.original.client.name}`}
            onClick={async () => {
              await copyToClipboard(row.original.client.clientId);
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
      size: 110,
      cell: ({ row }) => (
        <Badge variant="outline">
          {row.original.client.grantType === "authorization_code" ? (
            <span>On behalf of users</span>
          ) : (
            <span>Application</span>
          )}
        </Badge>
      ),
    },
    {
      id: "accessibleTo",
      header: "Accessible to",
      size: 110,
      cell: ({ row }) => (
        <ResourceVisibilityBadge
          scope={row.original.client.scope}
          teams={row.original.client.teams}
          authorId={row.original.client.authorId}
          authorName={row.original.client.authorName}
          currentUserId={currentUserId}
          showSelfAsMe
        />
      ),
    },
    {
      id: "actions",
      header: "Actions",
      // Three icon-sm buttons with the table's px-4 inset on both sides, so
      // the last icon sits 16px from the frame like every other cell edge.
      size: 128,
      cell: ({ row }) => {
        const isLlm = row.original.kind === "llm";
        const resource = isLlm ? "llmOauthClient" : "mcpOauthClient";
        return (
          <TableRowActions
            itemName={row.original.client.name}
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                permissions: { [resource]: ["update"] },
                onClick: () =>
                  row.original.kind === "llm"
                    ? setEditingLlm(row.original.client)
                    : setEditingMcp(row.original.client),
              },
              {
                icon: <RefreshCw className="h-4 w-4" />,
                label: "Rotate secret",
                permissions: { [resource]: ["update"] },
                onClick: () => setRotating(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                permissions: { [resource]: ["delete"] },
                variant: "destructive",
                onClick: () => setDeleting(row.original),
              },
            ]}
          />
        );
      },
    },
  ];

  if (llmQuery.isLoadingError || mcpQuery.isLoadingError) {
    return (
      <QueryLoadError
        title="Couldn't load OAuth clients"
        onRetry={() => {
          llmQuery.refetch();
          mcpQuery.refetch();
        }}
      />
    );
  }

  return (
    <div>
      <CollectionFilters>
        <FilterBar>
          <SearchInput
            isLoading={llmQuery.isFetching || mcpQuery.isFetching}
            objectNamePlural="OAuth clients"
            searchFields={["name"]}
            paramName="search"
            className={filterSearchClass}
          />
          <FilterSelect
            value={typeFilter ?? "all"}
            onValueChange={(value) =>
              updateQueryParams({
                type: value === "all" ? null : value,
                page: "1",
              })
            }
            placeholder="Filter by what it authenticates to"
            showSearch={false}
            items={[
              { value: "all", label: "All types" },
              { value: "llm", label: "LLM Proxy" },
              { value: "mcp", label: "MCP" },
            ]}
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
            showSearch={false}
            items={[
              { value: "all", label: "All grant types" },
              { value: "client_credentials", label: "Application" },
              { value: "authorization_code", label: "On behalf of users" },
            ]}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => `${row.kind}:${row.client.id}`}
        isLoading={llmQuery.isPending || mcpQuery.isPending}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={clearFilters}
        emptyMessage="No OAuth clients yet. Register one for an application that authenticates with OAuth."
        filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
      />

      <CreateOAuthClientDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultClientType={typeFilter ?? "mcp"}
        gateways={resources}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          const result =
            values.kind === "llm"
              ? await llmCreate.mutateAsync(values.body)
              : await mcpCreate.mutateAsync(values.body);
          if (result) {
            setRevealed({
              title: "OAuth Client Created",
              credentials: {
                ...result,
                oauthScope:
                  values.kind === "llm"
                    ? LLM_PROXY_OAUTH_SCOPE
                    : MCP_GATEWAY_OAUTH_SCOPE,
              },
            });
            setCreateOpen(false);
          }
        }}
        isSubmitting={llmCreate.isPending || mcpCreate.isPending}
      />

      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title={revealed?.title ?? "OAuth Client Created"}
        credentials={revealed?.credentials ?? null}
      />

      <EditLlmOAuthClientDialog
        oauthClient={editingLlm}
        onOpenChange={(open) => {
          if (!open) setEditingLlm(null);
        }}
        providerApiKeys={providerApiKeys}
        onSubmit={async (id, body) => {
          if (await llmUpdate.mutateAsync({ id, body })) setEditingLlm(null);
        }}
        isSubmitting={llmUpdate.isPending}
      />

      <EditMcpOAuthClientDialog
        oauthClient={editingMcp}
        onOpenChange={(open) => {
          if (!open) setEditingMcp(null);
        }}
        gateways={resources}
        onSubmit={async (id, body) => {
          if (await mcpUpdate.mutateAsync({ id, body })) setEditingMcp(null);
        }}
        isSubmitting={mcpUpdate.isPending}
      />

      <DeleteConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate Client Secret"
        description={`Rotate the secret for "${rotating?.client.name}"? The current secret stops working immediately; the new one is shown once.`}
        confirmLabel="Rotate"
        isPending={llmRotate.isPending || mcpRotate.isPending}
        onConfirm={async () => {
          if (!rotating) return;
          const id = rotating.client.id;
          const result =
            rotating.kind === "llm"
              ? await llmRotate.mutateAsync({ id })
              : await mcpRotate.mutateAsync({ id });
          if (result) {
            setRevealed({
              title: "Client Secret Rotated",
              credentials: {
                ...result,
                oauthScope:
                  rotating.kind === "llm"
                    ? LLM_PROXY_OAUTH_SCOPE
                    : MCP_GATEWAY_OAUTH_SCOPE,
              },
            });
          }
          setRotating(null);
        }}
      />

      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete OAuth Client"
        description={`Delete "${deleting?.client.name}"? Applications using it will stop authenticating. This action cannot be undone.`}
        confirmLabel="Delete"
        isPending={llmDelete.isPending || mcpDelete.isPending}
        onConfirm={() => {
          if (!deleting) return;
          const args = {
            id: deleting.client.id,
          };
          const done = { onSuccess: () => setDeleting(null) };
          if (deleting.kind === "llm") llmDelete.mutate(args, done);
          else mcpDelete.mutate(args, done);
        }}
      />
    </div>
  );
}

type GrantType = "client_credentials" | "authorization_code";

function isClientType(value: string | null) {
  return value === "llm" || value === "mcp";
}

function isGrantType(value: string | null) {
  return value === "client_credentials" || value === "authorization_code";
}
