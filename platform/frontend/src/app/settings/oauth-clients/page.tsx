"use client";

import {
  type archestraApiTypes,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import {
  Bot,
  Copy,
  type LucideIcon,
  Network,
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
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import { formatSpendCap } from "@/components/credential-billing/budget-fields";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EntityLabelFilter } from "@/components/entity-label-filter";
import {
  CollectionFilters,
  FilterBar,
  FilterSelect,
  filterControlClass,
  filterSearchClass,
} from "@/components/filter-bar";
import { LabelTags } from "@/components/label-tags";
import { EditOAuthClientDialog as EditLlmOAuthClientDialog } from "@/components/llm-oauth-client-dialogs";
import { EditOAuthClientDialog as EditMcpOAuthClientDialog } from "@/components/mcp-oauth-client-dialogs";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import {
  RESOURCE_ACCESS_FILTER_PARAMS,
  ResourceAccessFilter,
} from "@/components/resource-access-filter";
import { ResourceListActions } from "@/components/resource-list-actions";
import { useScopeFilterParams } from "@/components/resource-scope-filter";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import { PermissionButton } from "@/components/ui/permission-button";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useLlmOauthClientLabelKeys,
  useLlmOauthClientLabelValues,
} from "@/lib/entity-labels.query";
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
import { cn } from "@/lib/utils/tailwind";

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
  // Label filtering is server-side, so the value rides both list queries.
  const labelsFilter = searchParams.get("labels") || undefined;
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
  const _currentUserId = session?.user?.id;
  const providerCatalog = useModelProviderCatalog();
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const { data: resources = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const resourceNameById = new Map(resources.map((r) => [r.id, r.name]));

  // One set of access filters for both halves: who a client is shared with
  // and who created it read the same way for an LLM and an MCP client.
  const { hasActiveScopeFilters, access, sharedWith, owner } =
    useScopeFilterParams();
  const llmQuery = useLlmOauthClients({
    limit: ALL_CLIENTS_LIMIT,
    search: search || undefined,
    providerApiKeyId,
    labels: labelsFilter,
    access,
    sharedWith,
    owner,
    toastOnError: false,
  });
  // Read permission for the two halves is separate, and only the LLM one
  // gates the route — so ask for MCP clients only when this reader may see
  // them, rather than showing them a failed request.
  const { data: canReadMcp } = useHasPermissions({ mcpOauthClient: ["read"] });
  const mcpQuery = useMcpOauthClients({
    search: search || undefined,
    labels: labelsFilter,
    access,
    sharedWith,
    owner,
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
    search ||
      typeFilter ||
      grantTypeFilter ||
      providerApiKeyId ||
      labelsFilter ||
      hasActiveScopeFilters,
  );
  const clearFilters = useCallback(
    () =>
      updateQueryParams({
        search: null,
        type: null,
        grantType: null,
        providerApiKeyId: null,
        labels: null,
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
          permissions={{ llmOauthClient: ["create"] }}
          size="sm"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="h-4 w-4" />
          <span>Create OAuth Client</span>
        </PermissionButton>
        <ResourceListActions
          resource="llmOauthClient"
          label="LLM client permissions"
          alsoResources={[
            { resource: "mcpOauthClient", label: "MCP client permissions" },
          ]}
        />
      </div>,
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
      if (providers.length > 0) return providers.join(", ");
      return row.client.grantType === "authorization_code"
        ? "Each user's own keys"
        : "—";
    }
    if (row.client.allowedGatewayIds.length > 0) {
      return row.client.allowedGatewayIds
        .map((id) => resourceNameById.get(id) ?? id)
        .join(", ");
    }
    return row.client.grantType === "authorization_code"
      ? "What each user can reach"
      : "—";
  };

  const openEdit = (row: Row) =>
    row.kind === "llm" ? setEditingLlm(row.client) : setEditingMcp(row.client);

  const columns: ColumnDef<Row>[] = [
    {
      // The ID sits under the name: it is copied, not read, so it does not
      // need a column of its own.
      id: "name",
      header: "Name",
      size: 180,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-0.5">
          <span className="flex max-w-[180px] items-center gap-2 font-medium">
            <span className="truncate">{row.original.client.name}</span>
            {row.original.client.disabled && (
              <span className="text-muted-foreground">(disabled)</span>
            )}
            <LabelTags labels={row.original.client.labels} />
          </span>
          <div className="flex items-center gap-1 font-mono text-xs text-muted-foreground">
            <code className="max-w-[140px] truncate">
              {row.original.client.clientId}
            </code>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={`Copy client ID for ${row.original.client.name}`}
              onClick={async (e) => {
                e.stopPropagation();
                await copyToClipboard(row.original.client.clientId);
                toast.success("Client ID copied");
              }}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      ),
    },
    {
      // The kind and the resources it reaches are one fact, and the settings
      // column is too narrow to spend two columns saying it.
      id: "type",
      header: "Reaches",
      size: 190,
      cell: ({ row }) => {
        const Icon = row.original.kind === "llm" ? Bot : Network;
        return (
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0">
              <div className="text-sm">
                {row.original.kind === "llm" ? "LLM Proxy" : "MCP"}
              </div>
              <p className="max-w-[150px] truncate text-xs text-muted-foreground">
                {describeAccess(row.original)}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      // The wizard's own words for the grant type, so the list and the
      // dialog that created the client say the same thing.
      id: "grantType",
      header: "Signs in",
      size: 120,
      cell: ({ row }) => {
        const forUsers = row.original.client.grantType === "authorization_code";
        const Icon = forUsers ? Users : Server;
        return (
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Icon className="size-3.5 shrink-0" />
            {forUsers ? "For its users" : "As itself"}
          </span>
        );
      },
    },
    {
      id: "budget",
      header: "Budget",
      size: 130,
      cell: ({ row }) => {
        // MCP clients have no spend of their own.
        if (row.original.kind === "mcp") {
          return <span className="text-muted-foreground">—</span>;
        }
        const { client } = row.original;
        const forUsers = client.grantType === "authorization_code";
        return (
          <div className="min-w-0 text-sm">
            <div
              className={cn(
                "max-w-[130px] truncate",
                !forUsers && !client.billingTeam && "text-muted-foreground",
              )}
            >
              {forUsers ? "Each user" : (client.billingTeam?.name ?? "No team")}
            </div>
            <div className="text-xs text-muted-foreground">
              {client.spendCap
                ? `${formatSpendCap(client.spendCap)} cap`
                : "No cap"}
            </div>
          </div>
        );
      },
    },
    {
      id: "actions",
      header: "Actions",
      // Two icon-sm buttons with the table's px-4 inset on both sides.
      size: 100,
      cell: ({ row }) => {
        const isLlm = row.original.kind === "llm";
        const resource = isLlm ? "llmOauthClient" : "mcpOauthClient";
        return (
          <TableRowActions
            itemName={row.original.client.name}
            permissionScope={row.original.client.id}
            actions={[
              {
                icon: <Pencil className="h-4 w-4" />,
                label: "Edit",
                permissions: { [resource]: ["update"] },
                onClick: () => openEdit(row.original),
              },
            ]}
            dropdownActions={[
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
        <FilterBar
          search={
            <SearchInput
              isLoading={llmQuery.isFetching || mcpQuery.isFetching}
              objectNamePlural="OAuth clients"
              searchFields={["name"]}
              paramName="search"
              className={filterSearchClass}
            />
          }
        >
          <ResourceAccessFilter
            resource="llmOauthClient"
            noun="OAuth clients"
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
              {
                value: "llm",
                label: "LLM Proxy",
                content: <IconLabel icon={Bot} label="LLM Proxy" />,
              },
              {
                value: "mcp",
                label: "MCP",
                content: <IconLabel icon={Network} label="MCP" />,
              },
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
            placeholder="Filter by how it signs in"
            showSearch={false}
            items={[
              { value: "all", label: "All sign-in modes" },
              {
                value: "client_credentials",
                label: "As itself",
                content: <IconLabel icon={Server} label="As itself" />,
              },
              {
                value: "authorization_code",
                label: "For its users",
                content: <IconLabel icon={Users} label="For its users" />,
              },
            ]}
          />
          <EntityLabelFilter
            useLabelKeys={useLlmOauthClientLabelKeys}
            useLabelValues={useLlmOauthClientLabelValues}
            className={filterControlClass({
              active: Boolean(labelsFilter),
            })}
          />
        </FilterBar>
      </CollectionFilters>

      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => `${row.kind}:${row.client.id}`}
        onRowClick={openEdit}
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
        onRotateSecret={(client) => {
          setEditingLlm(null);
          setRotating({ kind: "llm", client });
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
        onRotateSecret={(client) => {
          setEditingMcp(null);
          setRotating({ kind: "mcp", client });
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

/** A filter option prefixed with the icon its table column uses. */
function IconLabel({ icon: Icon, label }: { icon: LucideIcon; label: string }) {
  return (
    <span className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      {label}
    </span>
  );
}

function isClientType(value: string | null) {
  return value === "llm" || value === "mcp";
}

function isGrantType(value: string | null) {
  return value === "client_credentials" || value === "authorization_code";
}
