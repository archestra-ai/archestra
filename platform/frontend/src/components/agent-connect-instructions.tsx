"use client";

import { type AgentType, MCP_GATEWAY_OAUTH_SCOPE } from "@archestra/shared";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import {
  resolveAdminDefaultBaseUrl,
  resolveCandidateBaseUrls,
} from "@/app/connection/connection-flow.utils";
import {
  GenericAuthRow,
  type SelectedGatewayToken,
} from "@/app/connection/mcp-client-instructions";
import { TerminalBlock } from "@/app/connection/terminal-block";
import { agentConfigureHref } from "@/components/agent-pages/agent-page-config";
import {
  type AuthMethodOption,
  AuthMethodPicker,
  ConnectStep,
  type ConnectStepProps,
  CreateNewLink,
  CredentialSelect,
  OauthTokenRequest,
} from "@/components/connect-rail";
import { CreateOAuthClientDialog } from "@/components/create-oauth-client-dialog";
import {
  type CreatedCredentials,
  OAuthClientCreatedDialog,
} from "@/components/oauth-client-created-dialog";
import { SECRET_PLACEHOLDER_TOKEN } from "@/components/secret-copy-button";
import { Button } from "@/components/ui/button";
import {
  CodeExample,
  MASKED_KEY,
  MaskedCodeExample,
} from "@/components/virtual-key-connection-guide";
import { useProfile, useProfiles } from "@/lib/agent.query";
import { useHasPermissions } from "@/lib/auth/auth.query";
import { useIdentityProviders } from "@/lib/auth/identity-provider-read.query";
import config from "@/lib/config/config";
import {
  useCreateMcpOauthClient,
  useMcpOauthClients,
} from "@/lib/mcp-oauth-clients.query";
import { useOrganization } from "@/lib/organization.query";

/**
 * Admin-facing "how to connect" content for the MCP Gateway detail pages, as
 * the same numbered rail as the LLM Proxy page: the endpoint, how callers
 * authenticate, then what that method needs. Unlike the /connection page
 * (end-user, one-client setup), it covers every way in and creates the
 * credentials for them.
 */

type ConnectTarget = {
  id: string;
  name: string;
  agentType: AgentType;
  identityProviderId?: string | null;
};

export function McpGatewayConnectInstructions({
  gateway,
}: {
  gateway: ConnectTarget & { slug?: string | null };
}) {
  const { baseUrl } = useConnectionBaseUrl();
  // Callers that only carry {id, name} don't know the slug — resolve it so
  // the endpoint URL is never the raw id.
  const { data: detail } = useProfile(
    gateway.slug == null ? gateway.id : undefined,
  );
  const slug = gateway.slug ?? detail?.slug ?? gateway.id;
  const [auth, setAuth] = useState<GatewayAuthMethod>("oauth");

  return (
    <ol>
      <ConnectStep number={1} title="Endpoint">
        <TerminalBlock
          rows={[{ badge: "URL", code: `${baseUrl}/mcp/${slug}` }]}
        />
      </ConnectStep>
      <ConnectStep number={2} title="Authentication">
        <AuthMethodPicker
          methods={GATEWAY_AUTH_METHODS}
          value={auth}
          onChange={setAuth}
        />
      </ConnectStep>
      <GatewayCredentialSteps
        // A pick belongs to one method; start over when it changes.
        key={auth}
        firstNumber={3}
        auth={auth}
        gateway={gateway}
        endpointUrl={`${baseUrl}/mcp/${slug}`}
      />
    </ol>
  );
}

// =========================================================================
// Authentication methods
// =========================================================================

type GatewayAuthMethod = "oauth" | "client" | "token" | "idp";

const GATEWAY_AUTH_METHODS: AuthMethodOption<GatewayAuthMethod>[] = [
  {
    value: "oauth",
    title: "OAuth sign-in",
    description:
      "For interactive clients such as Claude and Cursor. Each user signs in and gets the tools their permissions allow.",
  },
  {
    value: "client",
    title: "OAuth client",
    description: "Apps call the gateway as themselves, with no one signed in.",
    manage: {
      label: "Manage OAuth clients",
      href: "/settings/oauth-clients?type=mcp",
    },
  },
  {
    value: "token",
    title: "Platform token",
    description:
      "A personal or team token for headless clients and automations, with the owner's permissions.",
  },
  {
    value: "idp",
    title: "Identity provider",
    description:
      "Use a JWT from your identity provider. Requests run with that user's access.",
    manage: {
      label: "Manage identity providers",
      href: "/settings/identity-providers",
    },
  },
];

/**
 * Step 3, what the chosen method needs, and step 4, a `tools/list` request
 * with it. Sign-in has no request step: the client does it all itself.
 */
function GatewayCredentialSteps({
  firstNumber,
  auth,
  gateway,
  endpointUrl,
}: {
  firstNumber: number;
  auth: GatewayAuthMethod;
  gateway: ConnectTarget;
  endpointUrl: string;
}) {
  const oauthClient = useOauthClientStep(gateway, auth === "client");
  const idp = useIdentityProviderStep(gateway);
  const [token, setToken] = useState<SelectedGatewayToken | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  // Stable, since the token row reports through an effect keyed on it.
  const onTokenChange = useCallback((next: SelectedGatewayToken | null) => {
    setToken(next);
    setRevealed(null);
  }, []);

  let step: ConnectStepProps;
  let request: ConnectStepProps | null = null;
  const notReady = (detail: string): ConnectStepProps => ({
    title: "Send a request",
    detail,
  });

  if (auth === "oauth") {
    step = {
      done: true,
      title: "Sign in",
      detail:
        "Nothing to set up. Add the endpoint to your client; it registers itself and you sign in on first connect.",
    };
  } else if (auth === "client") {
    step = oauthClient.step;
    request = oauthClient.picked
      ? {
          title: "Send a request",
          detail: (
            <>
              <InlineCode>$ARCHESTRA_MCP_ACCESS_TOKEN</InlineCode> is the{" "}
              <InlineCode>access_token</InlineCode> from the token request
              above.
            </>
          ),
          children: (
            <CodeExample
              language="cURL"
              code={toolsListCurl(endpointUrl, "$ARCHESTRA_MCP_ACCESS_TOKEN")}
            />
          ),
        }
      : notReady("The request appears here once you pick an OAuth client.");
  } else if (auth === "token") {
    step = {
      done: !!token,
      title: "Platform token",
      detail: "Send it in the Authorization header as a bearer token.",
      children: (
        <GenericAuthRow
          placeholder={SECRET_PLACEHOLDER_TOKEN}
          onTokenChange={onTokenChange}
        />
      ),
    };
    request = token
      ? {
          title: "Send a request",
          children: (
            <MaskedCodeExample
              language="cURL"
              code={toolsListCurl(endpointUrl, MASKED_KEY)}
              placeholder="$ARCHESTRA_MCP_TOKEN"
              secret={{
                resolve: token.resolve,
                revealed,
                onRevealedChange: setRevealed,
              }}
            />
          ),
        }
      : notReady("The request appears here once you have a token.");
  } else {
    step = idp.step;
    request = idp.configured
      ? {
          title: "Send a request",
          detail: (
            <>
              <InlineCode>$ARCHESTRA_MCP_IDP_TOKEN</InlineCode> is a JWT from{" "}
              {idp.issuer ?? "your identity provider"}.
            </>
          ),
          children: (
            <CodeExample
              language="cURL"
              code={toolsListCurl(endpointUrl, "$ARCHESTRA_MCP_IDP_TOKEN")}
            />
          ),
        }
      : notReady("The request appears here once an identity provider is set.");
  }

  return (
    <>
      <ConnectStep number={firstNumber} {...step} />
      {request && <ConnectStep number={firstNumber + 1} {...request} />}
      {oauthClient.dialogs}
    </>
  );
}

/**
 * Lists the gateway's tools in one request. Naming a protocol revision lets
 * the gateway answer without a prior `initialize`.
 */
function toolsListCurl(endpointUrl: string, token: string) {
  return [
    `curl "${endpointUrl}" \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -H "Accept: application/json, text/event-stream" \\`,
    `  -H "MCP-Protocol-Version: ${MCP_PROTOCOL_REVISION}" \\`,
    `  -d '{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}'`,
  ].join("\n");
}

const MCP_PROTOCOL_REVISION = "2025-11-25";

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-xs">{children}</code>;
}

// =========================================================================
// OAuth client
// =========================================================================

/**
 * The OAuth clients allowed on this gateway: pick one to see how it gets a
 * token, or create one here. A new client's secret shows once, then it is
 * selected.
 */
function useOauthClientStep(
  gateway: ConnectTarget,
  enabled: boolean,
): {
  step: ConnectStepProps;
  picked: { id: string } | undefined;
  dialogs: React.ReactNode;
} {
  const { data: canCreate } = useHasPermissions({
    mcpOauthClient: ["create"],
  });
  const { data: clients = [] } = useMcpOauthClients({ enabled });
  const { data: resources = [] } = useProfiles({
    filters: { agentTypes: ["mcp_gateway", "agent"] },
  });
  const create = useCreateMcpOauthClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<CreatedCredentials | null>(null);
  const [pickedId, setPickedId] = useState<string | null>(null);

  const options = clients.filter((client) =>
    client.allowedGatewayIds.includes(gateway.id),
  );
  const picked = options.find((client) => client.id === pickedId) ?? options[0];
  const openCreate = () => setCreateOpen(true);

  const step: ConnectStepProps = {
    done: !!picked,
    title: "OAuth client",
    titleAction: options.length > 0 && canCreate && (
      <CreateNewLink label="Create new OAuth client" onCreate={openCreate} />
    ),
    detail: picked
      ? undefined
      : "Create one, or pick one allowed on this gateway.",
    actions: (
      <CredentialSelect
        label="OAuth client"
        createLabel="Create new OAuth client"
        canCreate={!!canCreate}
        onCreate={openCreate}
        options={options.map((client) => ({
          id: client.id,
          label: client.name,
        }))}
        value={picked?.id}
        onChange={(id) => setPickedId(id)}
      />
    ),
    children: picked && (
      <OauthTokenRequest
        clientId={picked.clientId}
        grantType={picked.grantType}
        scope={MCP_GATEWAY_OAUTH_SCOPE}
      />
    ),
  };

  const dialogs = (
    <>
      <CreateOAuthClientDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultClientType="mcp"
        fixedClientType="mcp"
        defaultAllowedGatewayIds={[gateway.id]}
        gateways={resources}
        providerApiKeys={[]}
        onSubmit={async (values) => {
          if (values.kind !== "mcp") return;
          const result = await create.mutateAsync(values.body);
          if (result) {
            setPickedId(result.id);
            setRevealed({ ...result, oauthScope: MCP_GATEWAY_OAUTH_SCOPE });
            setCreateOpen(false);
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
    </>
  );

  return { step, picked, dialogs };
}

// =========================================================================
// Identity provider
// =========================================================================

function useIdentityProviderStep(target: ConnectTarget): {
  step: ConnectStepProps;
  configured: boolean;
  issuer: string | undefined;
} {
  const { data: identityProviders } = useIdentityProviders();
  const { data: canUpdate } = useHasPermissions(
    { mcpGateway: ["update"] },
    target.id,
  );

  const idpId = target.identityProviderId;
  const idpName = identityProviders?.find((idp) => idp.id === idpId)?.issuer;
  // The edit form only shows its IdP field when the org has identity
  // providers configured — without any, "Edit …" would be a dead end, so
  // point at IdP setup instead.
  const orgHasIdps = (identityProviders?.length ?? 0) > 0;

  const step: ConnectStepProps = {
    done: !!idpId,
    title: "Identity provider",
    detail: idpId
      ? `Trusting ${idpName ?? "the selected identity provider"}. Send its JWT as the bearer token.`
      : "Not configured.",
    actions: !canUpdate ? null : orgHasIdps ? (
      <Button variant="outline" size="sm" asChild>
        <Link href={agentConfigureHref("mcp_gateway", target.id)}>
          {idpId ? "Change in gateway settings" : "Choose in gateway settings"}
        </Link>
      </Button>
    ) : (
      <Button size="sm" asChild>
        <Link href="/settings/identity-providers">
          Set up identity provider
        </Link>
      </Button>
    ),
  };
  return { step, configured: !!idpId, issuer: idpName };
}

// =========================================================================
// Shared pieces
// =========================================================================

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
