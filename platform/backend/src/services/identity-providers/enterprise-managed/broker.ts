// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { OAUTH_GRANT_TYPE, OAUTH_TOKEN_TYPE } from "@archestra/shared";
import type { TokenAuthContext } from "@/clients/mcp-client";
import logger from "@/logging";
import { resolveEnterpriseAssertion } from "@/services/identity-providers/enterprise-managed/assertion-resolver";
import {
  authenticateTokenRequest,
  resolveAgentClient,
  resolveIdentityProviderClient,
  resolveServerOverrideClient,
  type TokenEndpointClient,
} from "@/services/identity-providers/enterprise-managed/client-authentication";
import {
  type AgentIdentityContext,
  type EnterpriseCredentialIssuedTo,
  type EnterpriseManagedCredentialResult,
  exchangeEnterpriseManagedCredential,
  extractProviderErrorMessage,
} from "@/services/identity-providers/enterprise-managed/exchange";
import {
  type ExternalIdentityProviderConfig,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import type { EnterpriseManagedCredentialConfig, ToolOwner } from "@/types";

export type ResolvedEnterpriseTransportCredential = {
  headerName: string;
  headerValue: string;
  expiresInSeconds: number | null;
  /** The client the exchanged credential was issued to, when known. */
  issuedTo?: EnterpriseCredentialIssuedTo;
  /** The agent the exchange named as the actor, when it named one. */
  actor?: { clientId: string };
};

/**
 * Map an already-resolved credential value onto the outbound header the
 * catalog's injection mode asks for.
 *
 * Exported so every caller that obtains an enterprise-managed credential
 * injects it the same way. Handing the value to the transport as a static
 * `access_token` secret instead would silently force `Authorization: Bearer`
 * and ignore a configured custom header.
 */
export function buildEnterpriseCredentialHeader(params: {
  config: EnterpriseManagedCredentialConfig;
  value: string;
}): { headerName: string; headerValue: string } {
  const { config, value } = params;

  switch (config.tokenInjectionMode) {
    case "header":
      if (!config.headerName) {
        throw new Error(
          "Enterprise-managed credential injection mode 'header' requires headerName",
        );
      }
      return { headerName: config.headerName, headerValue: value };
    case "raw_authorization":
      return { headerName: "Authorization", headerValue: value };
    case "env":
    case "body_field":
      // Both describe a non-header carrier that an HTTP MCP transport cannot
      // express. Falling through to `Authorization: Bearer` would put the
      // credential somewhere the operator never asked for, so refuse instead.
      throw new Error(
        `Enterprise-managed credential injection mode '${config.tokenInjectionMode}' is not supported for HTTP MCP transports`,
      );
    default:
      return { headerName: "Authorization", headerValue: `Bearer ${value}` };
  }
}

export async function resolveEnterpriseTransportCredential(params: {
  owner: ToolOwner;
  tokenAuth?: TokenAuthContext;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
  /**
   * The calling agent's binding at the identity provider the exchange runs
   * at: `null` when it has none, `undefined` when no agent is calling.
   */
  agentIdentity?: AgentIdentityContext | null;
}): Promise<ResolvedEnterpriseTransportCredential | null> {
  const config = params.enterpriseManagedConfig;
  if (!config) {
    return null;
  }

  const assertion = await resolveEnterpriseAssertion({
    owner: params.owner,
    identityProviderId: config.identityProviderId,
    tokenAuth: params.tokenAuth,
  });
  if (!assertion) {
    logger.warn(
      {
        ownerType: params.owner.type,
        ownerId: params.owner.id,
        identityProviderId: config.identityProviderId,
        userId: params.tokenAuth?.userId,
      },
      "Unable to resolve enterprise assertion for enterprise-managed credential exchange",
    );
    return null;
  }

  if (config.assertionMode === "passthrough") {
    return normalizeEnterprisePassthroughCredential({
      config,
      assertion: assertion.assertion,
    });
  }

  if (shouldExchangeIdJagAtProtectedResource(config)) {
    // An ID-JAG the caller brought was requested by a client we do not know;
    // one we request names the client it was issued to.
    const idJag = params.tokenAuth?.isExternalIdp
      ? { assertion: assertion.assertion, issuedTo: undefined }
      : await exchangeSessionAssertionForIdJag({
          assertion: assertion.assertion,
          identityProviderId: assertion.identityProviderId,
          enterpriseManagedConfig: config,
          agentIdentity: params.agentIdentity,
        });
    const credential = await exchangeIdJagAtProtectedResource({
      assertion: idJag.assertion,
      idJagIssuedTo: idJag.issuedTo,
      identityProviderId: assertion.identityProviderId,
      enterpriseManagedConfig: config,
    });

    return normalizeEnterpriseTransportCredential({
      config,
      credential,
    });
  }

  const credential = await exchangeEnterpriseManagedCredential({
    identityProviderId: assertion.identityProviderId,
    assertion: assertion.assertion,
    enterpriseManagedConfig: config,
    agentIdentity: params.agentIdentity,
  });

  return normalizeEnterpriseTransportCredential({
    config,
    credential,
  });
}

async function exchangeSessionAssertionForIdJag(params: {
  assertion: string;
  identityProviderId: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
  agentIdentity: AgentIdentityContext | null | undefined;
}): Promise<{
  assertion: string;
  issuedTo: EnterpriseCredentialIssuedTo | undefined;
}> {
  const credential = await exchangeEnterpriseManagedCredential({
    identityProviderId: params.identityProviderId,
    assertion: params.assertion,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
    agentIdentity: params.agentIdentity,
  });

  return {
    assertion: extractInjectionValue({
      value: credential.value,
      responseFieldPath: params.enterpriseManagedConfig.responseFieldPath,
    }),
    issuedTo: credential.issuedTo,
  };
}

export async function exchangeIdJagAtProtectedResource(params: {
  assertion: string;
  /**
   * The client the ID-JAG was issued to, when Archestra requested it. The
   * resource's authorization server only accepts an ID-JAG from the client it
   * names, so an ID-JAG issued to an Okta AI agent is presented as that agent.
   */
  idJagIssuedTo?: EnterpriseCredentialIssuedTo;
  identityProviderId: string;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
}): Promise<EnterpriseManagedCredentialResult> {
  const resourceIdentifier = params.enterpriseManagedConfig.resourceIdentifier;
  if (!resourceIdentifier) {
    throw new Error(
      "ID-JAG protected resource exchange requires resourceIdentifier",
    );
  }

  const identityProvider = await findExternalIdentityProviderById(
    params.identityProviderId,
  );
  if (!identityProvider) {
    throw new Error("Enterprise identity provider not found");
  }

  const tokenEndpoint =
    await discoverProtectedResourceTokenEndpoint(resourceIdentifier);
  const { client, clientType } = resolveProtectedResourceClient({
    idJagIssuedTo: params.idJagIssuedTo,
    identityProvider,
    enterpriseManagedConfig: params.enterpriseManagedConfig,
    tokenEndpoint,
  });
  const requestBody = new URLSearchParams({
    grant_type: OAUTH_GRANT_TYPE.JwtBearer,
    assertion: params.assertion,
  });
  if (params.enterpriseManagedConfig.scopes?.length) {
    requestBody.set("scope", params.enterpriseManagedConfig.scopes.join(" "));
  }
  const headers = await authenticateTokenRequest({ client, requestBody });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers,
    body: requestBody.toString(),
    signal: AbortSignal.timeout(10_000),
  });
  const responseBody = (await response.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (!response.ok || !responseBody) {
    logger.warn(
      {
        status: response.status,
        error: responseBody?.error,
        errorDescription: responseBody?.error_description,
        resourceIdentifier,
      },
      "ID-JAG protected resource access-token exchange failed",
    );
    throw new Error(
      extractProviderErrorMessage(responseBody) ??
        "ID-JAG protected resource access-token exchange failed",
    );
  }

  const accessToken = responseBody.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("ID-JAG protected resource did not return an access token");
  }

  return {
    credentialType: "bearer_token",
    expiresInSeconds:
      typeof responseBody.expires_in === "number"
        ? responseBody.expires_in
        : null,
    value: accessToken,
    issuedTokenType:
      typeof responseBody.issued_token_type === "string"
        ? responseBody.issued_token_type
        : OAUTH_TOKEN_TYPE.AccessToken,
    issuedTo: { clientId: client.clientId, clientType },
  };
}

async function discoverProtectedResourceTokenEndpoint(
  resourceIdentifier: string,
): Promise<string> {
  const resourceMetadata = await fetchJson(
    buildProtectedResourceMetadataUrl(resourceIdentifier),
  );
  const authorizationServers = resourceMetadata.authorization_servers;
  if (
    !Array.isArray(authorizationServers) ||
    typeof authorizationServers[0] !== "string"
  ) {
    throw new Error(
      "OAuth protected resource metadata did not include an authorization server",
    );
  }

  const authServerMetadata = await fetchJson(
    `${authorizationServers[0].replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
  );
  const tokenEndpoint = authServerMetadata.token_endpoint;
  if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
    throw new Error(
      "OAuth authorization server metadata did not include a token endpoint",
    );
  }

  return tokenEndpoint;
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    headers: {
      "MCP-Protocol-Version": "2025-06-18",
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}`);
  }

  return (await response.json()) as Record<string, unknown>;
}

function buildProtectedResourceMetadataUrl(resourceIdentifier: string): string {
  const url = new URL(resourceIdentifier);
  const pathname = url.pathname.endsWith("/")
    ? url.pathname.slice(0, -1)
    : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${pathname}`;
}

/**
 * The client that presents the ID-JAG at the resource's authorization server:
 * the Okta AI agent it was issued to, else the MCP server's override client,
 * else the identity provider's client. A signed client assertion is addressed
 * to that authorization server's token endpoint.
 */
function resolveProtectedResourceClient(params: {
  idJagIssuedTo: EnterpriseCredentialIssuedTo | undefined;
  identityProvider: ExternalIdentityProviderConfig;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
  tokenEndpoint: string;
}): {
  client: TokenEndpointClient;
  clientType: EnterpriseCredentialIssuedTo["clientType"];
} {
  if (params.idJagIssuedTo?.clientType === "okta_ai_agent") {
    return {
      client: resolveAgentClient({
        agentIdentityConfig:
          params.identityProvider.oidcConfig?.enterpriseManagedCredentials
            ?.agentIdentity,
        agentClientId: params.idJagIssuedTo.clientId,
        tokenEndpoint: params.tokenEndpoint,
      }),
      clientType: "okta_ai_agent",
    };
  }

  const overrideClient = resolveServerOverrideClient({
    enterpriseManagedConfig: params.enterpriseManagedConfig,
    tokenEndpoint: params.tokenEndpoint,
    // Resource authorization servers commonly expect Basic; Post when the
    // identity provider's exchange is configured for it.
    secretMethod:
      params.identityProvider.oidcConfig?.enterpriseManagedCredentials
        ?.tokenEndpointAuthentication === "client_secret_post"
        ? "client_secret_post"
        : "client_secret_basic",
  });
  if (overrideClient) {
    return { client: overrideClient, clientType: "mcp_server" };
  }

  const client = resolveIdentityProviderClient({
    identityProvider: params.identityProvider,
    tokenEndpoint: params.tokenEndpoint,
    defaultMethod: "client_secret_basic",
  });
  return {
    client:
      client.auth.method === "private_key_jwt"
        ? {
            ...client,
            auth: {
              ...client.auth,
              clientAssertionAudience: params.tokenEndpoint,
            },
          }
        : client,
    clientType: "identity_provider",
  };
}

function shouldExchangeIdJagAtProtectedResource(
  config: EnterpriseManagedCredentialConfig,
): boolean {
  return (
    config.requestedCredentialType === "id_jag" &&
    config.resourceType === "oauth_protected_resource"
  );
}

function normalizeEnterpriseTransportCredential(params: {
  config: EnterpriseManagedCredentialConfig;
  credential: Awaited<ReturnType<typeof exchangeEnterpriseManagedCredential>>;
}): ResolvedEnterpriseTransportCredential {
  const { config, credential } = params;
  const scalarValue = extractInjectionValue({
    value: credential.value,
    responseFieldPath: config.responseFieldPath,
  });

  return {
    ...buildEnterpriseCredentialHeader({ config, value: scalarValue }),
    expiresInSeconds: credential.expiresInSeconds,
    ...(credential.issuedTo ? { issuedTo: credential.issuedTo } : {}),
    ...(credential.actor ? { actor: credential.actor } : {}),
  };
}

function normalizeEnterprisePassthroughCredential(params: {
  config: EnterpriseManagedCredentialConfig;
  assertion: string;
}): ResolvedEnterpriseTransportCredential {
  return {
    ...buildEnterpriseCredentialHeader({
      config: params.config,
      value: params.assertion,
    }),
    expiresInSeconds: null,
  };
}

function extractInjectionValue(params: {
  value: string | Record<string, unknown>;
  responseFieldPath?: string;
}): string {
  if (typeof params.value === "string") {
    return params.value;
  }

  if (!params.responseFieldPath) {
    throw new Error(
      "Enterprise-managed credential response is structured; configure responseFieldPath to extract the credential value",
    );
  }

  const extracted = getValueAtPath(params.value, params.responseFieldPath);
  if (extracted === undefined) {
    throw new Error(
      `Enterprise-managed credential response field '${params.responseFieldPath}' did not resolve to a value`,
    );
  }

  if (typeof extracted !== "string") {
    throw new Error(
      `Enterprise-managed credential response field '${params.responseFieldPath}' did not resolve to a string`,
    );
  }

  return extracted;
}

function getValueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, segment) => {
      if (isForbiddenPathSegment(segment)) {
        return undefined;
      }

      if (!current || typeof current !== "object" || Array.isArray(current)) {
        return undefined;
      }

      return (current as Record<string, unknown>)[segment];
    }, value);
}

function isForbiddenPathSegment(segment: string): boolean {
  return (
    segment === "__proto__" ||
    segment === "constructor" ||
    segment === "prototype"
  );
}
