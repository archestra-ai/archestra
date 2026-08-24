"use client";

import type { AgentType } from "@archestra/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { GenericAuthRow } from "@/app/connection/mcp-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { agentEditHref } from "@/components/agent-pages/agent-page-config";
import { McpOauthManagement } from "@/components/mcp-oauth-management";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useProfile } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import config from "@/lib/config/config";
import { useOrganization } from "@/lib/organization.query";

/**
 * Admin-facing "how to connect" content for the MCP Gateway detail pages.
 * Unlike the /connection page (end-user, one-client setup), the audience here
 * is the admin: the endpoint plus the full authentication surface — every
 * credential type the entity accepts, and create actions for minting
 * credentials per use case.
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
  const { data: canUpdate } = useHasPermissions({ mcpGateway: ["update"] });

  const idpId = target.identityProviderId;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  // The edit form only shows its IdP field when the org has identity
  // providers configured — without any, "Edit …" would be a dead end, so
  // point at IdP setup instead.
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;
  const editHref = agentEditHref("mcp_gateway", target.id);

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
          <Link href={editHref}>Edit gateway</Link>
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
  return { baseUrl };
}
