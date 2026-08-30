"use client";

import {
  type archestraApiTypes,
  MCP_GATEWAY_OAUTH_SCOPE,
} from "@archestra/shared";
import { Copy, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EditOAuthClientDialog } from "@/components/mcp-oauth-client-dialogs";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { QueryLoadError } from "@/components/query-load-error";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { Button } from "@/components/ui/button";
import { useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { copyToClipboard } from "@/lib/clipboard";
import {
  useCreateMcpOauthClient,
  useDeleteMcpOauthClient,
  useMcpOauthClients,
  useRotateMcpOauthClientSecret,
  useUpdateMcpOauthClient,
} from "@/lib/mcp-oauth-clients.query";

type Client = archestraApiTypes.GetMcpOauthClientsResponses["200"][number];

export function isMcpOauthClientApplicable(
  client: Pick<Client, "grantType" | "allowedGatewayIds">,
  resourceId: string,
) {
  return (
    client.grantType === "authorization_code" ||
    client.allowedGatewayIds.includes(resourceId)
  );
}

export function McpOauthManagement({
  resourceId,
  resourceKind,
  heading,
}: {
  resourceId: string;
  resourceKind: "agent" | "gateway";
  heading?: {
    title: string;
    description: string;
  };
}) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canRead } = useHasPermissions({ mcpOauthClient: ["read"] });
  const { data: canCreate } = useHasPermissions({ mcpOauthClient: ["create"] });
  const { data: canUpdate } = useHasPermissions({ mcpOauthClient: ["update"] });
  const { data: canDelete } = useHasPermissions({ mcpOauthClient: ["delete"] });
  const query = useMcpOauthClients({ enabled: canRead === true });
  const { data: resources = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const create = useCreateMcpOauthClient();
  const update = useUpdateMcpOauthClient();
  const rotate = useRotateMcpOauthClientSecret();
  const remove = useDeleteMcpOauthClient();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Client | null>(null);
  const [rotating, setRotating] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState<Client | null>(null);
  const [revealed, setRevealed] = useState<CreatedCredentials | null>(null);

  if (canRead === false) return null;

  const createButton =
    canCreate && !query.isPending && !query.isLoadingError ? (
      <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
        + Create OAuth client
      </Button>
    ) : null;
  const sectionHeading = heading ? (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-1">
        <h4 className="text-xs font-medium">{heading.title}</h4>
        <p className="text-xs text-muted-foreground">{heading.description}</p>
      </div>
      {createButton}
    </div>
  ) : null;

  if (query.isLoadingError) {
    return (
      <div className="space-y-3">
        {sectionHeading}
        <QueryLoadError
          title="Couldn't load OAuth clients"
          onRetry={() => query.refetch()}
        />
      </div>
    );
  }
  if (query.isPending)
    return (
      <div className="space-y-3">
        {sectionHeading}
        <p className="text-xs text-muted-foreground">Loading OAuth clients…</p>
      </div>
    );

  // Authorization-code clients are dynamically granted after user consent;
  // client-credentials clients are statically assigned to resources.
  const clients = (query.data ?? []).filter((client) =>
    isMcpOauthClientApplicable(client, resourceId),
  );

  return (
    <div className="space-y-3">
      {sectionHeading}
      {clients.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No OAuth clients for this {resourceKind} yet.
        </p>
      ) : (
        <div className="max-h-56 overflow-auto rounded-md border">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5">Name</th>
                <th className="px-3 py-1.5">Client ID</th>
                <th className="px-3 py-1.5">Accessible to</th>
                <th className="w-24 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {clients.map((client) => (
                <tr key={client.id} className="border-b last:border-0">
                  <td className="px-3 py-1.5 font-medium">
                    {client.name}
                    {client.disabled ? <span>{" (disabled)"}</span> : null}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className="flex items-center gap-1 font-mono">
                      <code className="max-w-52 truncate">
                        {client.clientId}
                      </code>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Copy client ID for ${client.name}`}
                        onClick={async () => {
                          await copyToClipboard(client.clientId);
                          toast.success("Client ID copied");
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  </td>
                  <td className="max-w-[180px] px-3 py-1.5">
                    <ResourceVisibilityBadge
                      scope={client.scope}
                      teams={client.teams}
                      authorId={client.authorId}
                      authorName={client.authorName}
                      currentUserId={currentUserId}
                      showSelfAsMe
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex">
                      {canUpdate && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Edit ${client.name}`}
                            onClick={() => setEditing(client)}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Rotate secret for ${client.name}`}
                            onClick={() => setRotating(client)}
                          >
                            <RefreshCw className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                      {canDelete && (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${client.name}`}
                          onClick={() => setDeleting(client)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-destructive" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!heading && createButton && (
        <div className="flex justify-end">{createButton}</div>
      )}
      <CreateOAuthClientDialog
        open={creating}
        onOpenChange={setCreating}
        defaultClientType="mcp"
        fixedClientType="mcp"
        defaultAllowedGatewayIds={[resourceId]}
        gateways={resources}
        providerApiKeys={[]}
        onSubmit={async (values) => {
          if (values.kind !== "mcp") return;
          const result = await create.mutateAsync(values.body);
          if (result) {
            setRevealed({
              ...result,
              oauthScope: MCP_GATEWAY_OAUTH_SCOPE,
            });
            setCreating(false);
          }
        }}
        isSubmitting={create.isPending}
      />
      <EditOAuthClientDialog
        oauthClient={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        gateways={resources}
        onSubmit={async (id, body) => {
          if (await update.mutateAsync({ id, body })) setEditing(null);
        }}
        isSubmitting={update.isPending}
      />
      <DeleteConfirmDialog
        open={!!rotating}
        onOpenChange={(open) => {
          if (!open) setRotating(null);
        }}
        title="Rotate Client Secret"
        description={`Rotate the secret for "${rotating?.name}"? The current secret stops working immediately.`}
        confirmLabel="Rotate"
        isPending={rotate.isPending}
        onConfirm={async () => {
          if (!rotating) return;
          const result = await rotate.mutateAsync({ id: rotating.id });
          if (result)
            setRevealed({ ...result, oauthScope: MCP_GATEWAY_OAUTH_SCOPE });
          setRotating(null);
        }}
      />
      <DeleteConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title="Delete OAuth Client"
        description={`Delete "${deleting?.name}"? Applications using it will stop authenticating.`}
        confirmLabel="Delete"
        isPending={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(
            { id: deleting.id },
            { onSuccess: () => setDeleting(null) },
          )
        }
      />
      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title="OAuth Client Secret"
        credentials={revealed}
      />
    </div>
  );
}
