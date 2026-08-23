"use client";

import {
  type AgentType,
  type archestraApiTypes,
  type ChatProvider,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
  type SupportedProvider,
} from "@archestra/shared";
import { Copy, Info, Pencil, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getConnectableProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { GenericAuthRow } from "@/app/connection/mcp-client-instructions";
import { GenericEndpointCard } from "@/app/connection/proxy-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { agentEditHref } from "@/components/agent-pages/agent-page-config";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import {
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { EditOAuthClientDialog as LlmEditOAuthClientDialog } from "@/components/llm-oauth-client-dialogs";
import { McpOauthManagement } from "@/components/mcp-oauth-management";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { ResourceVisibilityBadge } from "@/components/resource-visibility-badge";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { VirtualKeyManagement } from "@/components/virtual-key-management";
import { useProfile, useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { copyToClipboard } from "@/lib/clipboard";
import config from "@/lib/config/config";
import { useModelProviderCatalog } from "@/lib/integration-overrides";
import {
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
  useUpdateLlmOauthClient,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateMcpOauthClient } from "@/lib/mcp-oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * Admin-facing "how to connect" content for the LLM Proxy and MCP Gateway
 * detail pages. Unlike the /connection page (end-user, one-client setup), the
 * audience here is the admin: the endpoint plus the full authentication
 * surface — every credential type the entity accepts, how each reaches
 * models downstream, and create actions for minting credentials per use case.
 */

type ConnectTarget = {
  id: string;
  name: string;
  agentType: AgentType;
  identityProviderId?: string | null;
};

/**
 * Where the "Open the Connect page" link says it came from. Both values
 * pre-select the entity on /connection; the create flow announces itself so
 * the guide can keep doing so if the two ever diverge.
 */
export type ConnectInstructionsOrigin = "table" | "create";

export function LlmProxyConnectInstructions({
  proxy,
  origin,
}: {
  proxy: ConnectTarget;
  origin: ConnectInstructionsOrigin;
}) {
  const { baseUrl, organization } = useConnectionBaseUrl();
  // Local selection — this content must not write providerId into the page URL.
  const [selected, setSelected] = useState<"model-router" | ChatProvider>(
    "model-router",
  );

  const providers = getConnectableProviders(organization);

  return (
    <div className="space-y-4">
      <GenericEndpointCard
        baseUrl={baseUrl}
        profileId={proxy.id}
        providers={[...providers]}
        routerSelected={selected === "model-router"}
        selectedProvider={selected === "model-router" ? null : selected}
        onSelectRouter={() => setSelected("model-router")}
        onSelectProvider={setSelected}
        caption={<h3 className="text-sm font-semibold">Endpoint</h3>}
      />
      {selected === "model-router" && <ModelRouterAlert />}
      <LlmProxyAuthSurface proxy={proxy} />
      <ConnectionGuideFooter
        href={`/connection?proxyId=${encodeURIComponent(proxy.id)}&from=${origin}`}
      />
    </div>
  );
}

export function McpGatewayConnectInstructions({
  gateway,
  origin,
}: {
  gateway: ConnectTarget & { slug?: string | null };
  origin: ConnectInstructionsOrigin;
}) {
  const { baseUrl } = useConnectionBaseUrl();
  // Callers that only carry {id, name} don't know the slug — resolve it so
  // the endpoint URL is never the raw id.
  const { data: detail } = useProfile(
    gateway.slug == null ? gateway.id : undefined,
  );
  const slug = gateway.slug ?? detail?.slug ?? gateway.id;

  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border bg-card p-4">
        <h3 className="text-sm font-semibold">Endpoint</h3>
        <TerminalBlock code={`${baseUrl}/mcp/${slug}`} />
      </div>
      <McpGatewayAuthSurface gateway={gateway} />
      <ConnectionGuideFooter
        href={`/connection?gatewayId=${encodeURIComponent(gateway.id)}&from=${origin}`}
      />
    </div>
  );
}

// =========================================================================
// LLM Proxy authentication surface
// =========================================================================

type ProxyAuthTab = "virtual-keys" | "passthrough" | "oauth" | "idp";

function LlmProxyAuthSurface({ proxy }: { proxy: ConnectTarget }) {
  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [oauthCreateOpen, setOauthCreateOpen] = useState(false);
  const [authTab, setAuthTab] = useState<ProxyAuthTab>("virtual-keys");

  const { data: canReadOauth } = useHasPermissions({
    llmOauthClient: ["read"],
  });
  const { data: oauthClients } = useLlmOauthClients({
    enabled: authTab === "oauth" && canReadOauth === true,
    toastOnError: false,
  });

  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    llmOauthClient: ["create"],
  });

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Authentication</h3>
      <Tabs
        value={authTab}
        onValueChange={(value) => setAuthTab(value as ProxyAuthTab)}
      >
        <TabsList>
          <TabsTrigger value="virtual-keys">Virtual keys</TabsTrigger>
          <TabsTrigger value="passthrough">Passthrough</TabsTrigger>
          <TabsTrigger value="oauth">OAuth clients</TabsTrigger>
          <TabsTrigger value="idp">Identity provider</TabsTrigger>
        </TabsList>
      </Tabs>

      {authTab === "virtual-keys" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-3xl text-xs text-muted-foreground">
              Use one key in your app; the matching provider key is used for
              each request.
            </p>
            {canCreateKey ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setCreateKeyType("standard")}
              >
                Create virtual key
              </Button>
            ) : null}
          </div>
          <VirtualKeyManagement keyType="standard" />
        </div>
      )}

      {authTab === "passthrough" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-3xl text-xs text-muted-foreground">
              Send your provider key directly. A passthrough key links requests
              to a user but does not grant access.
            </p>
            {canCreateKey ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setCreateKeyType("passthrough")}
              >
                Create passthrough key
              </Button>
            ) : null}
          </div>
          <TerminalBlock
            rows={[
              {
                comment: "optional — link the request to a user",
                code: "X-Archestra-Virtual-Key: arch_<passthrough-key>",
              },
            ]}
          />
          <VirtualKeyManagement keyType="passthrough" />
        </div>
      )}

      {authTab === "oauth" && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="max-w-3xl text-xs text-muted-foreground">
              Register apps that call this proxy as themselves or for signed-in
              users.
            </p>
            {canCreateOauth ? (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setOauthCreateOpen(true)}
              >
                Create OAuth client
              </Button>
            ) : null}
          </div>
          <OauthClientTable
            proxyId={proxy.id}
            clients={canReadOauth ? oauthClients : undefined}
          />
        </div>
      )}

      {authTab === "idp" && <IdentityProviderStatus target={proxy} />}

      <CreateVirtualKeyDialogWithData
        open={createKeyType !== null}
        onOpenChange={(open) => {
          if (!open) setCreateKeyType(null);
        }}
        keyType={createKeyType ?? "standard"}
      />
      <OauthClientCreateFlow
        proxyId={proxy.id}
        open={oauthCreateOpen}
        onOpenChange={setOauthCreateOpen}
      />
    </section>
  );
}

function ModelRouterAlert() {
  return (
    <Alert variant="info">
      <Info />
      <AlertTitle>How Model Router works</AlertTitle>
      <AlertDescription>
        Use one OpenAI-compatible endpoint for models from different providers.
        The provider at the start of the model name tells Model Router where to
        send the request.
      </AlertDescription>
    </Alert>
  );
}

/**
 * Nested OAuth-client creation: the shared create dialog preset to an LLM
 * client allowed on this proxy, followed by the one-time credentials reveal.
 */
function OauthClientCreateFlow({
  proxyId,
  open,
  onOpenChange,
}: {
  proxyId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { data: gateways = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
    enabled: open,
  });
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
    enabled: open,
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys({
    enabled: open,
  });
  const mcpCreate = useCreateMcpOauthClient();
  const llmCreate = useCreateLlmOauthClient();
  const [createdCredentials, setCreatedCredentials] =
    useState<CreatedCredentials | null>(null);

  return (
    <>
      <CreateOAuthClientDialog
        open={open}
        onOpenChange={onOpenChange}
        defaultClientType="llm"
        fixedClientType="llm"
        defaultAllowedProxyIds={[proxyId]}
        gateways={gateways}
        llmProxies={llmProxies}
        providerApiKeys={providerApiKeys}
        onSubmit={async (values) => {
          const result =
            values.kind === "mcp"
              ? await mcpCreate.mutateAsync(values.body)
              : await llmCreate.mutateAsync(values.body);
          if (result) {
            setCreatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope:
                values.kind === "mcp"
                  ? MCP_GATEWAY_OAUTH_SCOPE
                  : LLM_PROXY_OAUTH_SCOPE,
            });
            onOpenChange(false);
          }
        }}
        isSubmitting={mcpCreate.isPending || llmCreate.isPending}
      />
      <OAuthClientCreatedDialog
        open={!!createdCredentials}
        onOpenChange={(open) => {
          if (!open) setCreatedCredentials(null);
        }}
        title="OAuth Client Created"
        credentials={createdCredentials}
      />
    </>
  );
}

// =========================================================================
// MCP Gateway authentication surface
// =========================================================================

type GatewayAuthTab = "oauth" | "token" | "idp";

function McpGatewayAuthSurface({ gateway }: { gateway: ConnectTarget }) {
  const [authTab, setAuthTab] = useState<GatewayAuthTab>("oauth");

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Authentication</h3>
      <Tabs
        value={authTab}
        onValueChange={(value) => setAuthTab(value as GatewayAuthTab)}
      >
        <TabsList>
          <TabsTrigger value="oauth">OAuth</TabsTrigger>
          <TabsTrigger value="token">Platform token</TabsTrigger>
          <TabsTrigger value="idp">Identity provider</TabsTrigger>
        </TabsList>
      </Tabs>

      {authTab === "oauth" && (
        <div className="space-y-3">
          <AuthFacts
            rows={[
              ["For", "interactive MCP clients such as Claude and Cursor"],
              [
                "How",
                "the client registers and signs in on first connect — nothing to copy",
              ],
              ["Access", "tools filtered by the signed-in user's permissions"],
            ]}
          />
          <div className="space-y-3 border-t pt-3">
            <div className="space-y-1">
              <p className="text-xs font-medium">Registered OAuth clients</p>
              <p className="text-xs text-muted-foreground">
                For applications calling as themselves or for signed-in users.
              </p>
            </div>
            <McpOauthManagement
              resourceId={gateway.id}
              resourceKind="gateway"
            />
          </div>
        </div>
      )}

      {authTab === "token" && (
        <div className="space-y-3">
          <AuthFacts
            rows={[
              ["For", "headless clients and automations"],
              ["How", "a personal or team token in the Bearer header"],
              ["Access", "tools filtered by the token owner's permissions"],
            ]}
          />
          <GenericAuthRow
            gatewayId={gateway.id}
            placeholder={SECRET_PLACEHOLDER_TOKEN}
          />
        </div>
      )}

      {authTab === "idp" && <IdentityProviderStatus target={gateway} />}
    </section>
  );
}

// =========================================================================
// Shared pieces
// =========================================================================

function IdentityProviderStatus({ target }: { target: ConnectTarget }) {
  const { data: identityProviders } = useIdentityProviders();
  const isGateway = target.agentType === "mcp_gateway";
  const { data: canUpdate } = useHasPermissions(
    isGateway ? { mcpGateway: ["update"] } : { llmProxy: ["update"] },
  );

  const idpId = target.identityProviderId;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  // The edit form only shows its IdP field when the org has identity
  // providers configured — without any, "Edit …" would be a dead end, so
  // point at IdP setup instead.
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;
  const editHref = agentEditHref(
    isGateway ? "mcp_gateway" : "llm_proxy",
    target.id,
  );

  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1.5">
        <p className="max-w-3xl text-xs text-muted-foreground">
          Use a JWT from your identity provider. Requests are linked to the user
          in the token and use that user&apos;s access.
        </p>
        <p className="text-xs">
          {idpId ? (
            <span className="text-green-600 dark:text-green-500">
              ● {idpName ?? "Identity provider"} — configured
            </span>
          ) : (
            <>○ Not configured</>
          )}
        </p>
      </div>
      {!canUpdate ? null : orgHasIdps ? (
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href={editHref}>Edit {isGateway ? "gateway" : "proxy"}</Link>
        </Button>
      ) : (
        <Button variant="outline" size="sm" className="shrink-0" asChild>
          <Link href="/settings/identity-providers">
            Set up identity providers
          </Link>
        </Button>
      )}
    </div>
  );
}

type LlmOauthClientRow =
  archestraApiTypes.GetLlmOauthClientsResponses["200"][number];

/** OAuth clients that can authenticate to this proxy. Secrets are not stored
 *  retrievably, so only the client ID is copyable. */
function OauthClientTable({
  proxyId,
  clients,
}: {
  proxyId: string;
  clients: LlmOauthClientRow[] | undefined;
}) {
  const providerCatalog = useModelProviderCatalog();
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canDelete } = useHasPermissions({
    llmOauthClient: ["delete"],
  });
  const { data: canUpdate } = useHasPermissions({
    llmOauthClient: ["update"],
  });
  const deleteMutation = useDeleteLlmOauthClient();
  const rotateMutation = useRotateLlmOauthClientSecret();
  const updateMutation = useUpdateLlmOauthClient();
  const { data: llmProxies = [] } = useProfiles({
    filters: { agentTypes: ["llm_proxy"] },
  });
  const { data: providerApiKeys = [] } = useLlmProviderApiKeys();
  const [editingClient, setEditingClient] = useState<LlmOauthClientRow | null>(
    null,
  );
  const [deletingClient, setDeletingClient] =
    useState<LlmOauthClientRow | null>(null);
  const [rotatingClient, setRotatingClient] =
    useState<LlmOauthClientRow | null>(null);
  const [rotatedCredentials, setRotatedCredentials] =
    useState<CreatedCredentials | null>(null);

  if (!clients) return null;
  const relevant = clients.filter(
    (client) =>
      client.grantType !== "client_credentials" ||
      client.allowedLlmProxyIds.includes(proxyId),
  );
  if (relevant.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No OAuth clients for this proxy yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="px-3 py-1.5 font-medium">Client ID</th>
            <th className="px-3 py-1.5 font-medium">Providers</th>
            <th className="px-3 py-1.5 font-medium">Accessible to</th>
            {(canUpdate || canDelete) && <th className="w-8 px-2 py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {relevant.map((client) => (
            <tr key={client.id} className="border-b last:border-0">
              <td className="max-w-[150px] truncate px-3 py-1.5 font-medium">
                {client.name}
                {client.disabled && (
                  <span className="ml-1.5 text-muted-foreground">
                    (disabled)
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5">
                <div className="flex items-center gap-1 font-mono">
                  <code className="max-w-[220px] truncate">
                    {client.clientId}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Copy client ID"
                    onClick={async () => {
                      await copyToClipboard(client.clientId);
                      toast.success("Client ID copied");
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </td>
              <td className="max-w-[140px] truncate px-3 py-1.5 text-muted-foreground">
                {client.providerApiKeys.length > 0
                  ? client.providerApiKeys
                      .map((mapping) => providerCatalog.label(mapping.provider))
                      .join(", ")
                  : "—"}
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
              {(canUpdate || canDelete) && (
                <td className="px-2 py-1.5">
                  <div className="flex items-center">
                    {canUpdate && (
                      <>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${client.name}`}
                          onClick={() => setEditingClient(client)}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Rotate secret for ${client.name}`}
                          onClick={() => setRotatingClient(client)}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                        </Button>
                      </>
                    )}
                    {canDelete && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${client.name}`}
                        onClick={() => setDeletingClient(client)}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-destructive" />
                      </Button>
                    )}
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

      <LlmEditOAuthClientDialog
        oauthClient={editingClient}
        onOpenChange={(open) => {
          if (!open) setEditingClient(null);
        }}
        llmProxies={llmProxies}
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
            setRotatedCredentials({
              clientId: result.clientId,
              clientSecret: result.clientSecret,
              grantType: result.grantType,
              oauthScope: LLM_PROXY_OAUTH_SCOPE,
            });
          }
          setRotatingClient(null);
        }}
      />
      <OAuthClientCreatedDialog
        open={!!rotatedCredentials}
        onOpenChange={(open) => {
          if (!open) setRotatedCredentials(null);
        }}
        title="Client Secret Rotated"
        credentials={rotatedCredentials}
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
            {
              onSuccess: () => setDeletingClient(null),
            },
          );
        }}
      />
    </div>
  );
}

function AuthFacts({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="text-foreground/90">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ConnectionGuideFooter({ href }: { href: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Need setup steps for your app?{" "}
      <Link href={href} className="text-primary hover:underline">
        Open the Connect page.
      </Link>
    </p>
  );
}

/** Same base-URL resolution as the /connection page. */
function useConnectionBaseUrl() {
  const { data: organization } = useOrganization();
  const connectionBaseUrls = organization?.connectionBaseUrls ?? null;
  const baseUrl = useMemo(() => {
    const candidates = resolveCandidateBaseUrls({
      externalProxyUrls: config.api.externalProxyUrls,
      internalProxyUrl: config.api.internalProxyUrl,
      metadata: connectionBaseUrls,
    });
    const adminDefault = resolveAdminDefaultBaseUrl(connectionBaseUrls);
    return adminDefault && candidates.includes(adminDefault)
      ? adminDefault
      : candidates[0];
  }, [connectionBaseUrls]);
  return { baseUrl, organization };
}
