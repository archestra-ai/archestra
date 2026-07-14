"use client";

import {
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared";
import type { ColumnDef } from "@tanstack/react-table";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  CreateOAuthClientDialog as LlmCreateOAuthClientDialog,
  EditOAuthClientDialog as LlmEditOAuthClientDialog,
  type LlmOauthClient,
} from "@/app/credentials/_parts/llm-oauth-client-dialogs";
import {
  CreateOAuthClientDialog as McpCreateOAuthClientDialog,
  EditOAuthClientDialog as McpEditOAuthClientDialog,
  type McpOauthClient,
} from "@/app/credentials/_parts/mcp-oauth-client-dialogs";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/app/credentials/_parts/oauth-client-created-dialog";
import { useSetCredentialsAction } from "@/components/credentials-action-context";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { LlmProviderApiKeyDropdown } from "@/components/llm-provider-api-key-dropdown";
import { formatProviderKeySummary } from "@/components/provider-key-mappings-field";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SearchInput } from "@/components/search-input";
import { TableRowActions } from "@/components/table-row-actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/ui/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useProfiles } from "@/lib/agent.query";
import { useSession } from "@/lib/auth/auth.query";
import { useDataTableQueryParams } from "@/lib/hooks/use-data-table-query-params";
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
import { formatRelativeTimeFromNow } from "@/lib/utils/date-time";

const GRANT_TYPE_LABEL: Record<McpOauthClient["grantType"], string> = {
  client_credentials: "Application",
  authorization_code: "User-delegated",
};

// One row for either client type. Common fields (name, clientId, grantType,
// scope, teams, author, createdAt) are shared; `kind` narrows to the
// type-specific fields (allowedGatewayIds vs allowedLlmProxyIds/providerApiKeys).
type UnifiedRow =
  | ({ kind: "mcp" } & McpOauthClient)
  | ({ kind: "llm" } & LlmOauthClient);

export default function UnifiedOAuthClientsPage() {
  const { searchParams, updateQueryParams } = useDataTableQueryParams();
  const search = searchParams.get("search") || "";
  // Provider-key filter is LLM-specific. When set, it deep-links from a
  // provider API key ("view clients using this key") and hides MCP/A2A clients,
  // which have no provider keys.
  const providerApiKeyIdFilter = searchParams.get("providerApiKeyId") || "all";
  const providerKeyFilterActive = providerApiKeyIdFilter !== "all";

  const {
    data: mcpClients = [],
    isPending: mcpPending,
    isLoadingError: mcpError,
    refetch: refetchMcp,
  } = useMcpOauthClients({ search: search || undefined });
  const {
    data: llmClients = [],
    isPending: llmPending,
    isLoadingError: llmError,
    refetch: refetchLlm,
  } = useLlmOauthClients({
    search: search || undefined,
    providerApiKeyId: providerKeyFilterActive
      ? providerApiKeyIdFilter
      : undefined,
    toastOnError: false,
  });

  // MCP clients scope to gateways and/or A2A agents; LLM clients scope to LLM
  // proxies and carry provider-key mappings.
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();

  const mcpCreate = useCreateMcpOauthClient();
  const mcpUpdate = useUpdateMcpOauthClient();
  const mcpRotate = useRotateMcpOauthClientSecret();
  const mcpDelete = useDeleteMcpOauthClient();
  const llmCreate = useCreateLlmOauthClient();
  const llmUpdate = useUpdateLlmOauthClient();
  const llmRotate = useRotateLlmOauthClientSecret();
  const llmDelete = useDeleteLlmOauthClient();

  const { data: session } = useSession();
  const currentUserId = session?.user?.id;

  const [mcpCreateOpen, setMcpCreateOpen] = useState(false);
  const [llmCreateOpen, setLlmCreateOpen] = useState(false);
  const [providerApiKeyFilterOpen, setProviderApiKeyFilterOpen] =
    useState(false);
  const [editing, setEditing] = useState<UnifiedRow | null>(null);
  const [rotating, setRotating] = useState<UnifiedRow | null>(null);
  const [deleting, setDeleting] = useState<UnifiedRow | null>(null);
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);
  const [rotatedCredentials, setRotatedCredentials] =
    useState<CreatedCredentials | null>(null);

  // A client is either an MCP/A2A client or an LLM client (they can't span
  // both), so "Create" picks the target surface before showing the form.
  const setCredentialsAction = useSetCredentialsAction();
  useEffect(() => {
    setCredentialsAction(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>
            <Plus className="h-4 w-4" />
            Create OAuth Client
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setMcpCreateOpen(true)}>
            For agents &amp; MCP gateways
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setLlmCreateOpen(true)}>
            For LLM proxies
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    return () => setCredentialsAction(null);
  }, [setCredentialsAction]);

  const rows: UnifiedRow[] = useMemo(
    () => [
      ...(providerKeyFilterActive
        ? []
        : mcpClients.map((c) => ({ kind: "mcp" as const, ...c }))),
      ...llmClients.map((c) => ({ kind: "llm" as const, ...c })),
    ],
    [mcpClients, llmClients, providerKeyFilterActive],
  );

  const columns: ColumnDef<UnifiedRow>[] = useMemo(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="font-medium">{row.original.name}</div>
        ),
      },
      {
        accessorKey: "clientId",
        header: "Client ID",
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.clientId}
          </code>
        ),
      },
      {
        id: "grantType",
        header: "Grant",
        cell: ({ row }) => (
          <Badge variant="secondary">
            {GRANT_TYPE_LABEL[row.original.grantType]}
          </Badge>
        ),
      },
      {
        id: "access",
        header: "Access",
        cell: ({ row }) => {
          const r = row.original;
          if (r.grantType === "authorization_code") {
            return (
              <span className="text-sm text-muted-foreground">
                User-delegated
              </span>
            );
          }
          if (r.kind === "mcp") {
            return (
              <span className="text-sm text-muted-foreground">
                {r.allowedGatewayIds.length} gateway/agent(s)
              </span>
            );
          }
          return (
            <span className="text-sm text-muted-foreground">
              {r.allowedLlmProxyIds.length} LLM proxy(ies)
              {r.providerApiKeys.length > 0
                ? ` · ${formatProviderKeySummary(r.providerApiKeys)}`
                : ""}
            </span>
          );
        },
      },
      {
        id: "visibility",
        header: "Accessible to",
        cell: ({ row }) => (
          <ResourceVisibilityBadge
            scope={row.original.scope}
            teams={row.original.teams}
            authorId={row.original.authorId}
            authorName={row.original.authorName}
            currentUserId={currentUserId}
          />
        ),
      },
      {
        accessorKey: "createdAt",
        header: "Created",
        cell: ({ row }) => (
          <span className="text-sm text-muted-foreground">
            {formatRelativeTimeFromNow(row.original.createdAt)}
          </span>
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
                label: "Edit",
                onClick: () => setEditing(row.original),
              },
              {
                icon: <RefreshCw className="h-4 w-4" />,
                label: "Rotate secret",
                onClick: () => setRotating(row.original),
              },
              {
                icon: <Trash2 className="h-4 w-4" />,
                label: "Delete",
                variant: "destructive",
                onClick: () => setDeleting(row.original),
              },
            ]}
          />
        ),
      },
    ],
    [currentUserId],
  );

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-4">
        <SearchInput
          objectNamePlural="OAuth clients"
          searchFields={["name"]}
          paramName="search"
        />
        <LlmProviderApiKeyDropdown
          availableKeys={providerApiKeys}
          selectedApiKeyId={
            providerKeyFilterActive ? providerApiKeyIdFilter : null
          }
          open={providerApiKeyFilterOpen}
          onOpenChange={setProviderApiKeyFilterOpen}
          onSelectKey={(value) => {
            updateQueryParams({ providerApiKeyId: value, page: "1" });
            setProviderApiKeyFilterOpen(false);
          }}
          triggerVariant="select"
          triggerClassName="w-full sm:w-[280px] h-9 text-sm"
          popoverClassName="w-[var(--radix-popover-trigger-width)]"
          allOptionLabel="All provider API keys"
          allOptionSelected={!providerKeyFilterActive}
          onSelectAllOption={() => {
            updateQueryParams({ providerApiKeyId: null, page: "1" });
            setProviderApiKeyFilterOpen(false);
          }}
        />
      </div>

      {mcpError || llmError ? (
        <QueryLoadError
          title="Couldn't load your OAuth clients"
          onRetry={() => {
            refetchMcp();
            refetchLlm();
          }}
        />
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          isLoading={mcpPending || llmPending}
          emptyMessage="No OAuth clients registered. Create one for an application that authenticates to your agents, MCP gateways, or LLM proxies."
          hasActiveFilters={Boolean(search || providerKeyFilterActive)}
          filteredEmptyMessage="No OAuth clients match your filters. Try adjusting your search."
          onClearFilters={() =>
            updateQueryParams({
              search: null,
              providerApiKeyId: null,
              page: "1",
            })
          }
        />
      )}

      <McpCreateOAuthClientDialog
        open={mcpCreateOpen}
        onOpenChange={setMcpCreateOpen}
        gateways={gateways}
        onSubmit={async (values) => {
          const result = await mcpCreate.mutateAsync(values);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope: MCP_GATEWAY_OAUTH_SCOPE,
            });
            setMcpCreateOpen(false);
          }
        }}
        isSubmitting={mcpCreate.isPending}
      />

      <LlmCreateOAuthClientDialog
        open={llmCreateOpen}
        onOpenChange={setLlmCreateOpen}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          const result = await llmCreate.mutateAsync(values);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope: LLM_PROXY_OAUTH_SCOPE,
            });
            setLlmCreateOpen(false);
          }
        }}
        isSubmitting={llmCreate.isPending}
      />

      <McpEditOAuthClientDialog
        oauthClient={editing?.kind === "mcp" ? editing : null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        gateways={gateways}
        onSubmit={async (id, values) => {
          const result = await mcpUpdate.mutateAsync({ id, body: values });
          if (result) setEditing(null);
        }}
        isSubmitting={mcpUpdate.isPending}
      />

      <LlmEditOAuthClientDialog
        oauthClient={editing?.kind === "llm" ? editing : null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (id, values) => {
          const result = await llmUpdate.mutateAsync({ id, body: values });
          if (result) setEditing(null);
        }}
        isSubmitting={llmUpdate.isPending}
      />

      <OAuthClientCreatedDialog
        open={!!createdCredentials}
        onOpenChange={(open) => {
          if (!open) setCreatedCredentials(null);
        }}
        title="OAuth Client Created"
        credentials={createdCredentials}
      />

      <OAuthClientCreatedDialog
        open={!!rotatedCredentials}
        onOpenChange={(open) => {
          if (!open) setRotatedCredentials(null);
        }}
        title="Secret Rotated"
        credentials={rotatedCredentials}
      />

      <DeleteConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate OAuth client secret"
        description={
          rotating
            ? `Rotate the secret for ${rotating.name}? Existing integrations using the current secret will not be able to request new access tokens.`
            : ""
        }
        onConfirm={async () => {
          if (!rotating) return;
          const result =
            rotating.kind === "mcp"
              ? await mcpRotate.mutateAsync({ id: rotating.id })
              : await llmRotate.mutateAsync({ id: rotating.id });
          if (result) {
            setRotatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope:
                rotating.kind === "mcp"
                  ? MCP_GATEWAY_OAUTH_SCOPE
                  : LLM_PROXY_OAUTH_SCOPE,
            });
          }
          setRotating(null);
        }}
        isPending={mcpRotate.isPending || llmRotate.isPending}
        confirmLabel="Rotate secret"
        pendingLabel="Rotating..."
      />

      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete OAuth client"
        description={
          deleting
            ? `Delete ${deleting.name}? Existing access tokens will stop working when they expire, and new tokens cannot be issued.`
            : ""
        }
        onConfirm={async () => {
          if (!deleting) return;
          if (deleting.kind === "mcp") {
            await mcpDelete.mutateAsync({ id: deleting.id });
          } else {
            await llmDelete.mutateAsync({ id: deleting.id });
          }
          setDeleting(null);
        }}
        isPending={mcpDelete.isPending || llmDelete.isPending}
      />
    </>
  );
}
