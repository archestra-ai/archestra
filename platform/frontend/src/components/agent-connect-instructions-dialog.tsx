"use client";

import {
  type AgentType,
  type archestraApiTypes,
  LLM_PROXY_OAUTH_SCOPE,
  MCP_GATEWAY_OAUTH_SCOPE,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import { Copy, Eye, EyeOff, RefreshCw, Trash2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import {
  getShownProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { GenericAuthRow } from "@/app/connection/mcp-client-instructions";
import { GenericEndpointCard } from "@/app/connection/proxy-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { useUpdateUrlParams } from "@/app/connection/use-update-url-params";
import { CreateOAuthClientDialog } from "@/app/credentials/_parts/create-oauth-client-dialog";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/app/credentials/_parts/oauth-client-created-dialog";
import { ConnectDialog } from "@/components/connect-dialog";
import {
  CreateVirtualKeyDialogWithData,
  type VirtualKeyType,
} from "@/components/create-virtual-key-dialog";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { formatProviderKeySummary } from "@/components/provider-key-mappings-field";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfile, useProfiles } from "@/lib/agent.query";
import { useHasPermissions, useSession } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import { copyToClipboard } from "@/lib/clipboard";
import config from "@/lib/config/config";
import {
  useCreateLlmOauthClient,
  useDeleteLlmOauthClient,
  useLlmOauthClients,
  useRotateLlmOauthClientSecret,
} from "@/lib/llm-oauth-clients.query";
import { useLlmProviderApiKeys } from "@/lib/llm-provider-api-keys.query";
import { useCreateMcpOauthClient } from "@/lib/mcp-oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";
import {
  useAllVirtualApiKeys,
  useDeleteVirtualApiKey,
  useFetchVirtualApiKeyValue,
} from "@/lib/virtual-api-keys.query";

/**
 * "Plug" row-action dialogs for the LLM Proxies and MCP Gateways tables.
 * Unlike the /connection page (end-user, one-client setup), the audience here
 * is the admin: the endpoint plus the full authentication surface — every
 * credential type the entity accepts, how each reaches models downstream,
 * and create actions for minting credentials per use case.
 */

type ConnectTarget = {
  id: string;
  name: string;
  agentType: AgentType;
};

const ALL_PROVIDERS = Object.keys(providerDisplayNames) as SupportedProvider[];

export function LlmProxyConnectInstructionsDialog({
  proxy,
  onOpenChange,
}: {
  /** Proxy to show instructions for; null keeps the dialog closed. */
  proxy: ConnectTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { baseUrl, organization } = useConnectionBaseUrl();
  // Local selection — the dialog must not write providerId into the list URL.
  const [selected, setSelected] = useState<"model-router" | SupportedProvider>(
    "model-router",
  );

  if (!proxy) return null;

  const providers = getShownProviders(organization) ?? ALL_PROVIDERS;

  return (
    <ConnectDialog agent={proxy} open onOpenChange={onOpenChange}>
      <div className="space-y-4">
        <GenericEndpointCard
          baseUrl={baseUrl}
          profileId={proxy.id}
          providers={[...providers]}
          routerSelected={selected === "model-router"}
          selectedProvider={selected === "model-router" ? null : selected}
          onSelectRouter={() => setSelected("model-router")}
          onSelectProvider={setSelected}
          caption={
            <div className="text-xs text-muted-foreground">Endpoint</div>
          }
        />
        <LlmProxyAuthSurface
          proxy={proxy}
          baseUrl={baseUrl}
          onClose={() => onOpenChange(false)}
        />
        <ConnectionGuideFooter
          href={`/connection?proxyId=${encodeURIComponent(proxy.id)}&from=table`}
        />
      </div>
    </ConnectDialog>
  );
}

export function McpGatewayConnectInstructionsDialog({
  gateway,
  onOpenChange,
}: {
  /** Gateway to show instructions for; null keeps the dialog closed. */
  gateway: (ConnectTarget & { slug?: string | null }) | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { baseUrl } = useConnectionBaseUrl();
  // Callers that only carry {id, name} (e.g. right after creation) don't know
  // the slug — resolve it so the endpoint URL is never the raw id.
  const { data: detail } = useProfile(
    gateway && gateway.slug == null ? gateway.id : undefined,
  );

  if (!gateway) return null;
  const slug = gateway.slug ?? detail?.slug ?? gateway.id;

  return (
    <ConnectDialog agent={gateway} open onOpenChange={onOpenChange}>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Endpoint</div>
          <TerminalBlock code={`${baseUrl}/mcp/${slug}`} />
        </div>
        <McpGatewayAuthSurface
          gateway={gateway}
          onClose={() => onOpenChange(false)}
        />
        <ConnectionGuideFooter
          href={`/connection?gatewayId=${encodeURIComponent(gateway.id)}&from=table`}
        />
      </div>
    </ConnectDialog>
  );
}

// =========================================================================
// LLM Proxy authentication surface
// =========================================================================

type ProxyAuthTab = "virtual-keys" | "passthrough" | "oauth" | "idp";

function LlmProxyAuthSurface({
  proxy,
  baseUrl,
  onClose,
}: {
  proxy: ConnectTarget;
  baseUrl: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<ProxyAuthTab>("virtual-keys");
  // Keys are created without leaving the dialog; the nested create dialog
  // stacks on top and the tables refresh via the create mutation's
  // invalidations.
  const [createKeyType, setCreateKeyType] = useState<VirtualKeyType | null>(
    null,
  );
  const [oauthCreateOpen, setOauthCreateOpen] = useState(false);

  const { data: canReadOauth } = useHasPermissions({
    llmOauthClient: ["read"],
  });
  const { data: oauthClients } = useLlmOauthClients({
    enabled: canReadOauth === true,
    toastOnError: false,
  });

  const { data: canCreateKey } = useHasPermissions({
    llmVirtualKey: ["create"],
  });
  const { data: canCreateOauth } = useHasPermissions({
    llmOauthClient: ["create"],
  });

  // The OAuth token endpoint lives at the backend root, not under /v1.
  const tokenEndpoint = `${baseUrl.replace(/\/v1\/?$/, "")}/api/auth/oauth2/token`;

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">
        Authentication
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as ProxyAuthTab)}>
        <TabsList>
          <TabsTrigger value="virtual-keys">Virtual keys</TabsTrigger>
          <TabsTrigger value="passthrough">Passthrough</TabsTrigger>
          <TabsTrigger value="oauth">OAuth clients</TabsTrigger>
          <TabsTrigger value="idp">Identity provider</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "virtual-keys" && (
        <div className="space-y-3">
          <AuthFacts
            rows={[
              ["For", "teammates and services without their own provider keys"],
              [
                "Downstream",
                "resolves to stored provider keys (Model Providers)",
              ],
              ["Routes", "Model Router + all provider routes"],
              ["Send", "as the API key (Authorization header)"],
            ]}
          />
          <VirtualKeyTable keyType="standard" />
          <AuthActionsRow
            summary={null}
            action={
              canCreateKey ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateKeyType("standard")}
                >
                  + Create virtual key
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {tab === "passthrough" && (
        <div className="space-y-3">
          <AuthFacts
            rows={[
              ["For", "users with their own provider key or subscription"],
              [
                "Downstream",
                "the key goes straight to the provider; guardrails, logs, and costs still apply",
              ],
              [
                "Routes",
                "provider routes; Model Router if the model prefix matches",
              ],
            ]}
          />
          <TerminalBlock
            rows={[
              {
                comment: "your provider key goes straight upstream",
                code: "Authorization: Bearer <your-provider-key>",
              },
              {
                comment: "optional — attribute requests to your Archestra user",
                code: "X-Archestra-Virtual-Key: arch_<your-passthrough-key>",
              },
            ]}
          />
          <VirtualKeyTable keyType="passthrough" />
          <AuthActionsRow
            summary="Passthrough keys are attribution-only — they grant nothing."
            action={
              canCreateKey ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCreateKeyType("passthrough")}
                >
                  + Create passthrough key
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {tab === "oauth" && (
        <div className="space-y-3">
          <AuthFacts
            rows={[
              ["For", "machine-to-machine apps"],
              [
                "Downstream",
                "resolves to stored provider keys, like a virtual key",
              ],
              ["Routes", "Model Router + provider routes"],
            ]}
          />
          <TerminalBlock
            rows={[
              {
                comment: "get an access token",
                code: `POST ${tokenEndpoint}\n  grant_type=client_credentials\n  client_id=<client-id>  client_secret=<client-secret>`,
              },
            ]}
          />
          <OauthClientTable
            proxyId={proxy.id}
            clients={canReadOauth ? oauthClients : undefined}
          />
          <AuthActionsRow
            summary={
              <>
                Secrets are shown once at creation — rotate in{" "}
                <Link
                  href="/credentials/oauth-clients"
                  className="text-primary hover:underline"
                >
                  Client Credentials
                </Link>{" "}
                to reissue.
              </>
            }
            action={
              canCreateOauth ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setOauthCreateOpen(true)}
                >
                  + Create OAuth client
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {tab === "idp" && (
        <IdentityProviderStatus target={proxy} onClose={onClose} />
      )}

      <CreateVirtualKeyDialogWithData
        open={createKeyType !== null}
        onOpenChange={(open) => {
          if (!open) setCreateKeyType(null);
        }}
        initialKeyType={createKeyType ?? "standard"}
      />
      <OauthClientCreateFlow
        proxyId={proxy.id}
        open={oauthCreateOpen}
        onOpenChange={setOauthCreateOpen}
      />
    </div>
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

function McpGatewayAuthSurface({
  gateway,
  onClose,
}: {
  gateway: ConnectTarget;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<GatewayAuthTab>("oauth");

  return (
    <div className="space-y-3 rounded-lg border bg-card p-4">
      <div className="text-xs font-medium text-muted-foreground">
        Authentication
      </div>
      <Tabs value={tab} onValueChange={(v) => setTab(v as GatewayAuthTab)}>
        <TabsList>
          <TabsTrigger value="oauth">OAuth 2.1</TabsTrigger>
          <TabsTrigger value="token">Platform token</TabsTrigger>
          <TabsTrigger value="idp">Identity provider</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "oauth" && (
        <AuthFacts
          rows={[
            ["For", "interactive MCP clients (Claude, Cursor, VS Code, …)"],
            [
              "How",
              "the client registers and signs in on first connect — nothing to copy",
            ],
            ["Access", "tools filtered by the signed-in user's permissions"],
          ]}
        />
      )}

      {tab === "token" && (
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

      {tab === "idp" && (
        <IdentityProviderStatus target={gateway} onClose={onClose} />
      )}
    </div>
  );
}

// =========================================================================
// Shared pieces
// =========================================================================

/** IdP tab body shared by both dialogs: status + edit deep link. */
function IdentityProviderStatus({
  target,
  onClose,
}: {
  target: ConnectTarget;
  onClose: () => void;
}) {
  const { data: detail } = useProfile(target.id);
  const { data: identityProviders } = useIdentityProviders();
  const { data: canUpdate } = useHasPermissions(
    target.agentType === "mcp_gateway"
      ? { mcpGateway: ["update"] }
      : { llmProxy: ["update"] },
  );
  const updateUrlParams = useUpdateUrlParams();

  const idpId = detail?.identityProviderId;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  // The edit dialog only shows its IdP field when the org has identity
  // providers configured — without any, "Edit …" would be a dead end, so
  // point at IdP setup instead.
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;

  return (
    <div className="space-y-3">
      <AuthFacts
        rows={[
          ["For", "clients that already hold JWTs from your IdP"],
          ["How", "JWT validated via JWKS; request attributed to its subject"],
          ["Downstream", "org provider keys"],
        ]}
      />
      <AuthActionsRow
        summary={
          idpId ? (
            <span className="text-green-600 dark:text-green-500">
              ● {idpName ?? "Identity provider"} — configured
            </span>
          ) : (
            <>○ Not configured</>
          )
        }
        action={
          !canUpdate ? null : orgHasIdps ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onClose();
                updateUrlParams({ edit: target.id });
              }}
            >
              Edit {target.agentType === "mcp_gateway" ? "gateway" : "proxy"}
            </Button>
          ) : (
            <Button variant="outline" size="sm" asChild>
              <Link href="/settings/identity-providers">
                Set up identity providers
              </Link>
            </Button>
          )
        }
      />
    </div>
  );
}

const KEY_TABLE_LIMIT = 8;

type VirtualKeyRow =
  archestraApiTypes.GetAllVirtualApiKeysResponses["200"]["data"][number];
type LlmOauthClientRow =
  archestraApiTypes.GetLlmOauthClientsResponses["200"][number];

/**
 * Compact key table for the auth tabs. Keys the viewer authored reveal and
 * copy their real value (author-only backend route); others stay masked.
 */
function VirtualKeyTable({ keyType }: { keyType: "standard" | "passthrough" }) {
  const { data: session } = useSession();
  const currentUserId = session?.user?.id;
  const { data: canRead } = useHasPermissions({ llmVirtualKey: ["read"] });
  const { data: canDelete } = useHasPermissions({ llmVirtualKey: ["delete"] });
  const { data, isPending } = useAllVirtualApiKeys({
    keyType,
    limit: KEY_TABLE_LIMIT,
    toastOnError: false,
    enabled: canRead === true,
  });
  const deleteMutation = useDeleteVirtualApiKey();
  const [deletingKey, setDeletingKey] = useState<VirtualKeyRow | null>(null);

  if (canRead === false) return null;
  const keys = data?.data ?? [];
  const total = data?.pagination.total ?? 0;
  if (!isPending && keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No {keyType === "passthrough" ? "passthrough " : ""}keys yet.
      </p>
    );
  }

  return (
    <div className="overflow-hidden rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-1.5 font-medium">Name</th>
            <th className="px-3 py-1.5 font-medium">Key</th>
            {keyType === "standard" && (
              <th className="px-3 py-1.5 font-medium">Providers</th>
            )}
            <th className="px-3 py-1.5 font-medium">Owner</th>
            {canDelete && <th className="w-8 px-2 py-1.5" />}
          </tr>
        </thead>
        <tbody>
          {keys.map((key: VirtualKeyRow) => (
            <tr key={key.id} className="border-b last:border-0">
              <td className="max-w-[150px] truncate px-3 py-1.5 font-medium">
                {key.name}
              </td>
              <td className="px-3 py-1.5">
                <VirtualKeyValueCell
                  id={key.id}
                  tokenStart={key.tokenStart}
                  canReveal={key.authorId === currentUserId}
                />
              </td>
              {keyType === "standard" && (
                <td className="max-w-[140px] truncate px-3 py-1.5 text-muted-foreground">
                  {formatProviderKeySummary(key.providerApiKeys)}
                </td>
              )}
              <td className="px-3 py-1.5 text-muted-foreground">
                {key.authorId === currentUserId
                  ? "Me"
                  : (key.authorName ?? "—")}
              </td>
              {canDelete && (
                <td className="px-2 py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Delete ${key.name}`}
                    onClick={() => setDeletingKey(key)}
                  >
                    <Trash2 className="h-3.5 w-3.5 text-destructive" />
                  </Button>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {total > keys.length && (
        <div className="border-t px-3 py-1.5 text-[11px] text-muted-foreground">
          {total - keys.length} more —{" "}
          <Link
            href="/credentials/virtual-keys"
            className="text-primary hover:underline"
          >
            Client Credentials
          </Link>
        </div>
      )}

      <DeleteConfirmDialog
        open={!!deletingKey}
        onOpenChange={(open) => {
          if (!open) setDeletingKey(null);
        }}
        title="Delete Virtual Key"
        description={`Are you sure you want to delete "${deletingKey?.name}"? This action cannot be undone.`}
        confirmLabel="Delete"
        isPending={deleteMutation.isPending}
        onConfirm={() => {
          if (!deletingKey) return;
          deleteMutation.mutate(
            { id: deletingKey.id },
            {
              onSuccess: () => setDeletingKey(null),
            },
          );
        }}
      />
    </div>
  );
}

function VirtualKeyValueCell({
  id,
  tokenStart,
  canReveal,
}: {
  id: string;
  tokenStart: string;
  canReveal: boolean;
}) {
  const fetchValue = useFetchVirtualApiKeyValue();
  const [value, setValue] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const resolveValue = async () => {
    if (value) return value;
    const fetched = await fetchValue.mutateAsync(id);
    if (fetched) setValue(fetched);
    return fetched;
  };

  return (
    <div className="flex items-center gap-1 font-mono">
      <code className={visible && value ? "break-all" : "whitespace-nowrap"}>
        {visible && value ? value : `${tokenStart}…`}
      </code>
      {canReveal && (
        <>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={visible ? "Hide key" : "Reveal key"}
            disabled={fetchValue.isPending}
            onClick={async () => {
              if (!visible && !(await resolveValue())) return;
              setVisible(!visible);
            }}
          >
            {visible ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Copy key"
            disabled={fetchValue.isPending}
            onClick={async () => {
              const resolved = await resolveValue();
              if (!resolved) return;
              await copyToClipboard(resolved);
              toast.success("Key copied");
            }}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </>
      )}
    </div>
  );
}

/** OAuth clients that can authenticate to this proxy. Secrets are not stored
 *  retrievably, so only the client ID is copyable. */
function OauthClientTable({
  proxyId,
  clients,
}: {
  proxyId: string;
  clients: LlmOauthClientRow[] | undefined;
}) {
  const { data: canDelete } = useHasPermissions({
    llmOauthClient: ["delete"],
  });
  const { data: canUpdate } = useHasPermissions({
    llmOauthClient: ["update"],
  });
  const deleteMutation = useDeleteLlmOauthClient();
  const rotateMutation = useRotateLlmOauthClientSecret();
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
            {canDelete && <th className="w-8 px-2 py-1.5" />}
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
                      .map((mapping) => providerDisplayNames[mapping.provider])
                      .join(", ")
                  : "—"}
              </td>
              {canDelete && (
                <td className="px-2 py-1.5">
                  <div className="flex items-center">
                    {canUpdate && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rotate secret for ${client.name}`}
                        onClick={() => setRotatingClient(client)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete ${client.name}`}
                      onClick={() => setDeletingClient(client)}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-destructive" />
                    </Button>
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>

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

function AuthActionsRow({
  summary,
  action,
}: {
  summary: React.ReactNode;
  action: React.ReactNode;
}) {
  if (!summary && !action) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
      <span>{summary}</span>
      {action}
    </div>
  );
}

function ConnectionGuideFooter({ href }: { href: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      Setting up a specific client?{" "}
      <Link href={href} className="text-primary hover:underline">
        Connect page
      </Link>
    </p>
  );
}

/** Same base-URL resolution as the /connection page and post-create dialog. */
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
