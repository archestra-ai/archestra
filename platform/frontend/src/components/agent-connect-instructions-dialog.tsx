"use client";

import {
  type AgentType,
  providerDisplayNames,
  type SupportedProvider,
} from "@archestra/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  getShownProviders,
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { GenericAuthRow } from "@/app/connection/mcp-client-instructions";
import { GenericEndpointCard } from "@/app/connection/proxy-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { useUpdateUrlParams } from "@/app/connection/use-update-url-params";
import { ConnectDialog } from "@/components/connect-dialog";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import config from "@/lib/config/config";
import { useLlmOauthClients } from "@/lib/llm-oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";
import { useAllVirtualApiKeys } from "@/lib/virtual-api-keys.query";

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

  if (!gateway) return null;

  return (
    <ConnectDialog agent={gateway} open onOpenChange={onOpenChange}>
      <div className="space-y-4">
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">Endpoint</div>
          <TerminalBlock
            code={`${baseUrl}/mcp/${gateway.slug ?? gateway.id}`}
          />
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

  const { data: canReadKeys } = useHasPermissions({ llmVirtualKey: ["read"] });
  const { data: keysResponse } = useAllVirtualApiKeys({
    limit: 1,
    toastOnError: false,
    enabled: canReadKeys === true,
  });
  const virtualKeyCount = keysResponse?.pagination.total;

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
            ]}
          />
          <TerminalBlock
            rows={[
              {
                comment: "send as the API key",
                code: "Authorization: arch_<your-virtual-key>",
              },
            ]}
          />
          <AuthActionsRow
            summary={
              canReadKeys && virtualKeyCount !== undefined ? (
                <>
                  {virtualKeyCount} {virtualKeyCount === 1 ? "key" : "keys"} can
                  access this proxy —{" "}
                  <Link
                    href="/credentials/virtual-keys"
                    className="text-primary hover:underline"
                  >
                    Client Credentials
                  </Link>
                </>
              ) : null
            }
            action={
              canCreateKey ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/credentials/virtual-keys?create=true">
                    + Create virtual key
                  </Link>
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
          <AuthActionsRow
            summary="Passthrough keys are attribution-only — they grant nothing."
            action={
              canCreateKey ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/credentials/virtual-keys?create=passthrough">
                    + Create passthrough key
                  </Link>
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
          <AuthActionsRow
            summary={
              canReadOauth && oauthClients ? (
                <>
                  {oauthClients.length} OAuth{" "}
                  {oauthClients.length === 1 ? "client" : "clients"} configured
                  —{" "}
                  <Link
                    href="/credentials/oauth-clients"
                    className="text-primary hover:underline"
                  >
                    Client Credentials
                  </Link>
                </>
              ) : null
            }
            action={
              canCreateOauth ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href="/credentials/oauth-clients?create=true">
                    + Create OAuth client
                  </Link>
                </Button>
              ) : null
            }
          />
        </div>
      )}

      {tab === "idp" && (
        <IdentityProviderStatus target={proxy} onClose={onClose} />
      )}
    </div>
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
