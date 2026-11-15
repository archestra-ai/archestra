// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import {
  type EntraAgentIdConfig,
  OAUTH_GRANT_TYPE,
  OAUTH_TOKEN_TYPE,
} from "@archestra/shared";
import { decodeJwt } from "jose";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import { ApiError } from "@/types";
import {
  authenticateTokenRequest,
  resolveIdentityProviderClient,
  resolveServerOverrideClient,
  type TokenEndpointClient,
} from "../client-authentication";
import {
  assertAgentIdentityRequirement,
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseCredentialIssuedTo,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";

/**
 * Microsoft Entra On-Behalf-Of exchange. The downstream token is issued to one
 * of three clients, most specific first:
 *
 * 1. The calling agent's Entra agent identity (Entra Agent ID). Archestra
 *    authenticates as the agent identity blueprint, asks for an exchange token
 *    naming the agent identity (`fmi_path`), and presents it as the agent
 *    identity's client assertion in the OBO request.
 * 2. The MCP server's override client (`clientIdOverride`).
 * 3. The identity provider's own exchange client.
 *
 * Entra only accepts an OBO assertion whose audience is the client presenting
 * it. For (1) and (2) the user's token is first exchanged by the identity
 * provider's client for a token addressed to the blueprint or override client,
 * unless it already is.
 */
// Declared before the class: its singleton is created at module load.
const AGENT_EXCHANGE_TOKEN_SCOPE = "api://AzureADTokenExchange/.default";
const EXCHANGE_TOKEN_EXPIRY_MARGIN_SECONDS = 300;
const EXCHANGE_TOKEN_FALLBACK_TTL_MS = 5 * 60 * 1000;

class EntraOboStrategy implements EnterpriseCredentialExchangeStrategy {
  private exchangeTokenCache = new LRUCacheManager<string>({
    maxSize: 1_000,
    defaultTtl: EXCHANGE_TOKEN_FALLBACK_TTL_MS,
  });

  async exchangeCredential(
    params: EnterpriseCredentialExchangeParams,
  ): Promise<EnterpriseManagedCredentialResult> {
    const enterpriseConfig =
      params.identityProvider.oidcConfig?.enterpriseManagedCredentials;
    if (!enterpriseConfig) {
      throw new Error(
        "Identity provider is missing enterprise-managed credential exchange configuration",
      );
    }

    const scope = resolveScope(params.enterpriseManagedConfig);
    const agentIdConfig = enterpriseConfig.entraAgentId?.blueprintClientId
      ? enterpriseConfig.entraAgentId
      : undefined;
    const agentIdentityId = params.agentIdentity?.externalId ?? null;
    if (agentIdentityId && !agentIdConfig) {
      throw new ApiError(
        400,
        "This agent is bound to a Microsoft Entra agent identity, but the identity provider has no agent identity blueprint configured. Configure Entra Agent ID on the identity provider, or remove the agent's binding.",
      );
    }
    assertAgentIdentityRequirement({
      agentIdentity: params.agentIdentity,
      requireAgentIdentity: agentIdConfig?.requireAgentIdentity,
    });

    const tokenEndpoint =
      enterpriseConfig.tokenEndpoint ??
      params.identityProvider.oidcConfig?.tokenEndpoint ??
      (await discoverOidcTokenEndpoint(params.identityProvider.issuer));
    if (!tokenEndpoint) {
      throw new Error("Unable to determine Entra OBO token endpoint");
    }

    const identityProviderClient = resolveIdentityProviderClient({
      identityProvider: params.identityProvider,
      tokenEndpoint,
      defaultMethod: "client_secret_post",
    });

    if (agentIdentityId && agentIdConfig) {
      return this.exchangeAsAgentIdentity({
        agentIdConfig,
        agentIdentityId,
        assertion: params.assertion,
        identityProviderClient,
        identityProviderId: params.identityProvider.id,
        scope,
        tokenEndpoint,
      });
    }

    const overrideClient = resolveServerOverrideClient({
      enterpriseManagedConfig: params.enterpriseManagedConfig,
      tokenEndpoint,
      secretMethod: "client_secret_post",
    });
    if (overrideClient) {
      const assertion = await addressAssertionTo({
        assertion: params.assertion,
        audienceClientId: overrideClient.clientId,
        scope: `api://${overrideClient.clientId}/.default`,
        identityProviderClient,
        identityProviderId: params.identityProvider.id,
        tokenEndpoint,
      });
      return requestOnBehalfOf({
        assertion,
        client: overrideClient,
        identityProviderId: params.identityProvider.id,
        issuedTo: {
          clientId: overrideClient.clientId,
          clientType: "mcp_server",
        },
        scope,
        tokenEndpoint,
      });
    }

    return requestOnBehalfOf({
      assertion: params.assertion,
      client: identityProviderClient,
      identityProviderId: params.identityProvider.id,
      issuedTo: {
        clientId: identityProviderClient.clientId,
        clientType: "identity_provider",
      },
      scope,
      tokenEndpoint,
    });
  }

  private async exchangeAsAgentIdentity(params: {
    agentIdConfig: EntraAgentIdConfig;
    agentIdentityId: string;
    assertion: string;
    identityProviderClient: TokenEndpointClient;
    identityProviderId: string;
    scope: string;
    tokenEndpoint: string;
  }): Promise<EnterpriseManagedCredentialResult> {
    const blueprintClient = resolveBlueprintClient({
      agentIdConfig: params.agentIdConfig,
      tokenEndpoint: params.tokenEndpoint,
    });

    // Tc: the user's token, addressed to the blueprint.
    const userAssertion = await addressAssertionTo({
      assertion: params.assertion,
      audienceClientId: blueprintClient.clientId,
      scope:
        params.agentIdConfig.blueprintScope?.trim() ||
        `api://${blueprintClient.clientId}/.default`,
      identityProviderClient: params.identityProviderClient,
      identityProviderId: params.identityProviderId,
      tokenEndpoint: params.tokenEndpoint,
    });

    // T1: the blueprint's exchange token naming the agent identity. It does
    // not depend on the user, so one serves every user of that agent.
    const exchangeToken = await this.getAgentExchangeToken({
      agentIdentityId: params.agentIdentityId,
      blueprintClient,
      identityProviderId: params.identityProviderId,
      tokenEndpoint: params.tokenEndpoint,
    });

    return requestOnBehalfOf({
      assertion: userAssertion,
      client: {
        clientId: params.agentIdentityId,
        auth: { method: "client_assertion", clientAssertion: exchangeToken },
      },
      identityProviderId: params.identityProviderId,
      issuedTo: {
        clientId: params.agentIdentityId,
        clientType: "entra_agent_identity",
      },
      scope: params.scope,
      tokenEndpoint: params.tokenEndpoint,
    });
  }

  private async getAgentExchangeToken(params: {
    agentIdentityId: string;
    blueprintClient: TokenEndpointClient;
    identityProviderId: string;
    tokenEndpoint: string;
  }): Promise<string> {
    const cacheKey = JSON.stringify({
      tokenEndpoint: params.tokenEndpoint,
      blueprintClientId: params.blueprintClient.clientId,
      agentIdentityId: params.agentIdentityId,
    });
    const cached = this.exchangeTokenCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const requestBody = new URLSearchParams({
      client_id: params.blueprintClient.clientId,
      grant_type: "client_credentials",
      scope: AGENT_EXCHANGE_TOKEN_SCOPE,
      fmi_path: params.agentIdentityId,
    });
    const token = await postTokenRequest({
      client: params.blueprintClient,
      failureLog: "Entra agent identity exchange token request failed",
      identityProviderId: params.identityProviderId,
      requestBody,
      tokenEndpoint: params.tokenEndpoint,
    });

    if (token.expiresInSeconds && token.expiresInSeconds > 0) {
      const ttlMs =
        (token.expiresInSeconds - EXCHANGE_TOKEN_EXPIRY_MARGIN_SECONDS) * 1000;
      if (ttlMs > 0) {
        this.exchangeTokenCache.set(cacheKey, token.accessToken, ttlMs);
      }
    } else {
      this.exchangeTokenCache.set(cacheKey, token.accessToken);
    }
    return token.accessToken;
  }
}

export const entraOboStrategy = new EntraOboStrategy();

// === Internal helpers ===

function resolveBlueprintClient(params: {
  agentIdConfig: EntraAgentIdConfig;
  tokenEndpoint: string;
}): TokenEndpointClient {
  const { agentIdConfig } = params;
  if (agentIdConfig.privateKeyPem) {
    return {
      clientId: agentIdConfig.blueprintClientId,
      auth: {
        method: "private_key_jwt",
        privateKeyPem: agentIdConfig.privateKeyPem,
        privateKeyId: agentIdConfig.certificateThumbprint,
        clientAssertionAudience: params.tokenEndpoint,
      },
    };
  }

  if (!agentIdConfig.clientSecret) {
    throw new ApiError(
      400,
      "The identity provider's Entra agent identity blueprint has no client secret or certificate. Add one under Tool Access → Entra Agent ID.",
    );
  }

  return {
    clientId: agentIdConfig.blueprintClientId,
    auth: {
      method: "client_secret_post",
      clientSecret: agentIdConfig.clientSecret,
    },
  };
}

/**
 * Returns an assertion whose audience is `audienceClientId`. Exchanges the
 * user's token with the identity provider's client when its audience is a
 * different client. A token whose audience cannot be read is passed through
 * unchanged, and Entra reports the mismatch.
 */
async function addressAssertionTo(params: {
  assertion: string;
  audienceClientId: string;
  scope: string;
  identityProviderClient: TokenEndpointClient;
  identityProviderId: string;
  tokenEndpoint: string;
}): Promise<string> {
  const audiences = readAssertionAudiences(params.assertion);
  if (
    !audiences ||
    audiences.some(
      (audience) =>
        audience === params.audienceClientId ||
        audience === `api://${params.audienceClientId}`,
    )
  ) {
    return params.assertion;
  }

  const requestBody = new URLSearchParams({
    client_id: params.identityProviderClient.clientId,
    grant_type: OAUTH_GRANT_TYPE.JwtBearer,
    requested_token_use: "on_behalf_of",
    assertion: params.assertion,
    scope: params.scope,
  });
  const token = await postTokenRequest({
    client: params.identityProviderClient,
    failureLog: "Entra OBO exchange to the middle-tier client failed",
    identityProviderId: params.identityProviderId,
    requestBody,
    tokenEndpoint: params.tokenEndpoint,
  });
  return token.accessToken;
}

async function requestOnBehalfOf(params: {
  assertion: string;
  client: TokenEndpointClient;
  identityProviderId: string;
  issuedTo: EnterpriseCredentialIssuedTo;
  scope: string;
  tokenEndpoint: string;
}): Promise<EnterpriseManagedCredentialResult> {
  const requestBody = new URLSearchParams({
    client_id: params.client.clientId,
    grant_type: OAUTH_GRANT_TYPE.JwtBearer,
    requested_token_use: "on_behalf_of",
    assertion: params.assertion,
  });
  requestBody.set("scope", params.scope);

  const token = await postTokenRequest({
    client: params.client,
    failureLog: "Enterprise-managed Entra OBO exchange failed",
    identityProviderId: params.identityProviderId,
    requestBody,
    tokenEndpoint: params.tokenEndpoint,
  });

  return {
    credentialType: "bearer_token",
    expiresInSeconds: token.expiresInSeconds,
    value: token.accessToken,
    issuedTokenType: token.issuedTokenType ?? OAUTH_TOKEN_TYPE.AccessToken,
    issuedTo: params.issuedTo,
  };
}

async function postTokenRequest(params: {
  client: TokenEndpointClient;
  failureLog: string;
  identityProviderId: string;
  requestBody: URLSearchParams;
  tokenEndpoint: string;
}): Promise<{
  accessToken: string;
  expiresInSeconds: number | null;
  issuedTokenType: string | null;
}> {
  const headers = await authenticateTokenRequest({
    client: params.client,
    requestBody: params.requestBody,
  });

  const response = await fetch(params.tokenEndpoint, {
    method: "POST",
    headers,
    body: params.requestBody.toString(),
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
        identityProviderId: params.identityProviderId,
        clientId: params.client.clientId,
      },
      params.failureLog,
    );
    const message = buildExchangeErrorMessage(
      extractProviderErrorMessage(responseBody),
    );
    // A rejected assertion or client credential needs configuration/account
    // repair, rather than being reported as an internal server failure.
    if (
      (response.status === 400 || response.status === 401) &&
      typeof responseBody?.error === "string"
    ) {
      throw new ApiError(400, message);
    }
    throw new Error(message);
  }

  const accessToken = responseBody.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new Error("Entra OBO exchange did not return an access token");
  }

  return {
    accessToken,
    expiresInSeconds:
      typeof responseBody.expires_in === "number"
        ? responseBody.expires_in
        : null,
    issuedTokenType:
      typeof responseBody.issued_token_type === "string"
        ? responseBody.issued_token_type
        : null,
  };
}

function readAssertionAudiences(assertion: string): string[] | null {
  try {
    const { aud } = decodeJwt(assertion);
    if (typeof aud === "string") return [aud];
    if (Array.isArray(aud)) return aud;
    return null;
  } catch {
    return null;
  }
}

function buildExchangeErrorMessage(
  providerMessage: string | null | undefined,
): string {
  // AADSTS50013 ("assertion failed signature validation") on an OBO request
  // almost always means the linked Entra access token was issued for
  // Microsoft Graph: Graph tokens use a proprietary nonce-transformed
  // signature that no token endpoint can verify. That happens when the
  // linked IdP's scopes don't include a delegated scope exposed by the app
  // registration used for the exchange.
  if (providerMessage?.includes("AADSTS50013")) {
    return (
      "Entra rejected the on-behalf-of assertion because its signature could not be validated (AADSTS50013). " +
      "This usually means the linked Entra access token was issued for Microsoft Graph instead of the app registration used for the exchange. " +
      "Add a delegated scope exposed by that app registration (for example api://<client-id>/access_as_user) to the identity provider's scopes, then reconnect the Entra account. " +
      `Provider error: ${providerMessage}`
    );
  }

  // AADSTS65001: no consent for the client to call the requested scope as
  // this user. For an agent identity this is the agent's own grant.
  if (providerMessage?.includes("AADSTS65001")) {
    return (
      "Entra has no consent for this client to call the requested resource on the user's behalf (AADSTS65001). " +
      "Grant admin consent for the scope to the client named in the error: the agent identity, the MCP server's exchange client, or the identity provider's app registration. " +
      `Provider error: ${providerMessage}`
    );
  }

  return providerMessage ?? "Enterprise-managed credential exchange failed";
}

function resolveScope(
  enterpriseManagedConfig: EnterpriseCredentialExchangeParams["enterpriseManagedConfig"],
): string {
  const scopes = enterpriseManagedConfig.scopes
    ?.map((scope) => scope.trim())
    .filter(Boolean);
  if (scopes?.length) {
    return scopes.join(" ");
  }

  const resource =
    enterpriseManagedConfig.resourceIdentifier?.trim() ||
    enterpriseManagedConfig.audience?.trim();
  if (!resource) {
    throw new ApiError(
      400,
      "Configure a Managed Resource Identifier or scopes for this MCP server before using Entra token exchange.",
    );
  }

  // resourceIdentifier/audience are treated as Entra resource identifiers here,
  // not literal scope strings. Callers that need custom scopes must set scopes.
  if (resource.endsWith("/.default")) {
    return resource;
  }

  return `${resource.replace(/\/$/, "")}/.default`;
}
