"use client";

import { type AgentType, MCP_GATEWAY_OAUTH_SCOPE } from "@archestra/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import { GenericAuthRow } from "@/app/connection/mcp-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { agentEditHref } from "@/components/agent-pages/agent-page-config";
import { AuthMethodRow } from "@/components/auth-method-row";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import { useProfile, useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import config from "@/lib/config/config";
import { useCreateMcpOauthClient } from "@/lib/mcp-oauth-clients.query";
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
 * Where the guided-setup link says it came from. Both values pre-select the
 * entity on /connection; the create flow announces itself so the guide can
 * keep doing so if the two ever diverge.
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

function McpGatewayAuthSurface({ gateway }: { gateway: ConnectTarget }) {
  const [createOauthOpen, setCreateOauthOpen] = useState(false);
  const { data: canCreateOauth } = useHasPermissions({
    mcpOauthClient: ["create"],
  });
  const { data: canReadOauth } = useHasPermissions({
    mcpOauthClient: ["read"],
  });
  const { data: resources = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const create = useCreateMcpOauthClient();
  const [revealed, setRevealed] = useState<CreatedCredentials | null>(null);

  return (
    <section className="rounded-lg border bg-card p-4">
      <h3 className="text-sm font-semibold">Authentication</h3>
      {/* One row per way in, rather than a tab strip. The tabs put two of the
          four behind a click, which is the same reason a reader never found
          the pages this gateway's siblings live on. Mirrors the LLM Proxy's
          own authentication list so the two read as one surface. */}
      <div className="mt-1 divide-y">
        <AuthMethodRow
          title="OAuth"
          description="For interactive MCP clients such as Claude and Cursor. The client registers itself and the user signs in on first connect — nothing to copy — and its tools are filtered by that user's permissions."
        />

        <AuthMethodRow
          title="OAuth clients"
          description="Register applications that call this gateway as themselves, for services running with no one signed in."
          action={
            canCreateOauth ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setCreateOauthOpen(true)}
              >
                Create OAuth client
              </Button>
            ) : null
          }
          manageHref={canReadOauth ? "/settings/oauth-clients?type=mcp" : null}
          manageLabel="Manage OAuth clients"
        />

        <AuthMethodRow
          title="Platform token"
          description="For headless clients and automations: a personal or team token in the Bearer header, with tools filtered by the token owner's permissions."
        >
          <GenericAuthRow
            gatewayId={gateway.id}
            placeholder={SECRET_PLACEHOLDER_TOKEN}
          />
        </AuthMethodRow>

        <IdentityProviderStatus target={gateway} />
      </div>

      <CreateOAuthClientDialog
        open={createOauthOpen}
        onOpenChange={setCreateOauthOpen}
        defaultClientType="mcp"
        fixedClientType="mcp"
        defaultAllowedGatewayIds={[gateway.id]}
        gateways={resources}
        providerApiKeys={[]}
        onSubmit={async (values) => {
          if (values.kind !== "mcp") return;
          const result = await create.mutateAsync(values.body);
          if (result) {
            setRevealed({ ...result, oauthScope: MCP_GATEWAY_OAUTH_SCOPE });
            setCreateOauthOpen(false);
          }
        }}
        isSubmitting={create.isPending}
      />
      <OAuthClientCreatedDialog
        open={!!revealed}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
        title="OAuth Client Created"
        credentials={revealed}
      />
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
    <AuthMethodRow
      title="Identity provider"
      description="Use a JWT from your identity provider. Requests are linked to the user in the token and use that user's access."
      action={
        !canUpdate ? null : orgHasIdps ? (
          <Button variant="outline" size="sm" className="shrink-0" asChild>
            <Link href={editHref}>Edit gateway</Link>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="shrink-0" asChild>
            <Link href="/settings/identity-providers">
              Set up identity providers
            </Link>
          </Button>
        )
      }
    >
      <p className="text-xs">
        {idpId ? (
          <span className="text-green-600 dark:text-green-500">
            ● {idpName ?? "Identity provider"} — configured
          </span>
        ) : (
          <span>○ Not configured</span>
        )}
      </p>
    </AuthMethodRow>
  );
}

/**
 * The way out to the guided per-client setup at /connection.
 *
 * It used to read "Need setup steps for your app? Open the Connect page.",
 * printed under a section this page headed "Connect" — so the reader was
 * offered a Connect page while apparently already on one, and "your app"
 * named neither the client being configured nor an Archestra app. Name the
 * destination by what it does instead.
 */
function ConnectionGuideFooter({ href }: { href: string }) {
  return (
    <p className="text-xs text-muted-foreground">
      <Link href={href} className="text-primary hover:underline">
        Set up a client step by step
      </Link>{" "}
      — choose your client and copy its ready-made configuration.
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
