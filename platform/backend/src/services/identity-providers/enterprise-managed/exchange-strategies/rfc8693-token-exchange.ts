// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { OAUTH_GRANT_TYPE, OAUTH_TOKEN_TYPE } from "@archestra/shared";
import { LRUCacheManager } from "@/in-memory-lru-cache";
import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import {
  authenticateTokenRequest,
  resolveAgentClient,
  resolveIdentityProviderClient,
  type TokenEndpointClient,
} from "../client-authentication";
import {
  assertAgentIdentityRequirement,
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";
import { spiffeIssuer } from "../spiffe-issuer";

/**
 * RFC 8693 token exchange. When the calling agent is bound to its own client at
 * the identity provider, the agent is the actor: Archestra gets a client
 * credentials token as the agent's client and sends it as `actor_token`, so a
 * provider that supports delegation (Keycloak, PingOne, ZITADEL, Auth0 Custom
 * Token Exchange) issues a token with the person in `sub` and the agent in
 * `act`. Whether the provider adds `act` is its policy, not the request's.
 * With SPIFFE agent identities the actor token is instead the agent's JWT-SVID,
 * which the provider trusts through Archestra's SPIFFE issuer, so agents need
 * no client of their own there.
 */
// Declared before the class: its singleton is created at module load.
const ACTOR_TOKEN_EXPIRY_MARGIN_SECONDS = 300;

class Rfc8693TokenExchangeStrategy
  implements EnterpriseCredentialExchangeStrategy
{
  private actorTokenCache = new LRUCacheManager<string>({ maxSize: 1_000 });

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

    const tokenEndpoint =
      enterpriseConfig.tokenEndpoint ??
      params.identityProvider.oidcConfig?.tokenEndpoint ??
      (await discoverOidcTokenEndpoint(params.identityProvider.issuer));
    if (!tokenEndpoint) {
      throw new Error("Unable to determine standard token exchange endpoint");
    }

    assertAgentIdentityRequirement({
      agentIdentity: params.agentIdentity,
      requireAgentIdentity:
        enterpriseConfig.agentIdentity?.requireAgentIdentity,
    });

    const exchangeClient = resolveIdentityProviderClient({
      identityProvider: params.identityProvider,
      tokenEndpoint,
      defaultMethod: "client_secret_post",
    });

    const requestBody = new URLSearchParams({
      client_id: exchangeClient.clientId,
      grant_type: OAUTH_GRANT_TYPE.TokenExchange,
      requested_token_type: mapRequestedTokenType(
        params.enterpriseManagedConfig.requestedCredentialType,
      ),
      subject_token: params.assertion,
      subject_token_type:
        enterpriseConfig.subjectTokenType ?? OAUTH_TOKEN_TYPE.AccessToken,
    });

    const targetAudience =
      params.enterpriseManagedConfig.audience ??
      params.enterpriseManagedConfig.resourceIdentifier;
    if (targetAudience) {
      requestBody.set("audience", targetAudience);
    }

    if (params.enterpriseManagedConfig.resourceIdentifier) {
      requestBody.set(
        "resource",
        params.enterpriseManagedConfig.resourceIdentifier,
      );
    }

    if (params.enterpriseManagedConfig.requestedIssuer) {
      requestBody.set(
        "requested_issuer",
        params.enterpriseManagedConfig.requestedIssuer,
      );
    }

    if (params.enterpriseManagedConfig.scopes?.length) {
      requestBody.set("scope", params.enterpriseManagedConfig.scopes.join(" "));
    }

    const agentClientId = params.agentIdentity?.externalId ?? null;
    if (agentClientId && enterpriseConfig.agentIdentity?.source === "spiffe") {
      requestBody.set(
        "actor_token",
        await spiffeIssuer.mintJwtSvid({
          spiffeId: agentClientId,
          audience:
            enterpriseConfig.agentIdentity.spiffeAudience ||
            params.identityProvider.issuer,
        }),
      );
      requestBody.set("actor_token_type", OAUTH_TOKEN_TYPE.Jwt);
    } else if (agentClientId) {
      requestBody.set(
        "actor_token",
        await this.getActorToken({
          agentClient: resolveAgentClient({
            agentIdentityConfig: enterpriseConfig.agentIdentity,
            agentClientId,
            tokenEndpoint,
          }),
          identityProviderId: params.identityProvider.id,
          scope: enterpriseConfig.agentIdentity?.actorTokenScope || undefined,
          tokenEndpoint,
        }),
      );
      requestBody.set("actor_token_type", OAUTH_TOKEN_TYPE.AccessToken);
    }

    const headers = await authenticateTokenRequest({
      client: exchangeClient,
      requestBody,
    });

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
          identityProviderId: params.identityProvider.id,
        },
        "Enterprise-managed standard token exchange failed",
      );
      throw new Error(
        extractProviderErrorMessage(responseBody) ??
          "Enterprise-managed credential exchange failed",
      );
    }

    const accessToken = responseBody.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error("Standard token exchange did not return an access token");
    }

    return {
      credentialType:
        params.enterpriseManagedConfig.requestedCredentialType ??
        "bearer_token",
      expiresInSeconds:
        typeof responseBody.expires_in === "number"
          ? responseBody.expires_in
          : null,
      value: accessToken,
      issuedTokenType:
        typeof responseBody.issued_token_type === "string"
          ? responseBody.issued_token_type
          : OAUTH_TOKEN_TYPE.AccessToken,
      ...(agentClientId ? { actor: { clientId: agentClientId } } : {}),
    };
  }

  /**
   * The agent's own access token, from a client credentials grant as the
   * agent's client. It does not depend on the person, so one serves every
   * person the agent acts for until shortly before it expires.
   */
  private async getActorToken(params: {
    agentClient: TokenEndpointClient;
    identityProviderId: string;
    scope: string | undefined;
    tokenEndpoint: string;
  }): Promise<string> {
    const cacheKey = JSON.stringify({
      tokenEndpoint: params.tokenEndpoint,
      clientId: params.agentClient.clientId,
      scope: params.scope ?? null,
    });
    const cached = this.actorTokenCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const requestBody = new URLSearchParams({
      grant_type: "client_credentials",
    });
    if (params.scope) {
      requestBody.set("scope", params.scope);
    }
    const headers = await authenticateTokenRequest({
      client: params.agentClient,
      requestBody,
    });
    const response = await fetch(params.tokenEndpoint, {
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
          identityProviderId: params.identityProviderId,
          clientId: params.agentClient.clientId,
        },
        "Agent actor token request failed",
      );
      throw new Error(
        `The identity provider refused the agent's own token: ${
          extractProviderErrorMessage(responseBody) ?? `HTTP ${response.status}`
        }`,
      );
    }

    const accessToken = responseBody.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error(
        "The identity provider returned no access token for the agent's client",
      );
    }

    const expiresInSeconds = responseBody.expires_in;
    if (
      typeof expiresInSeconds === "number" &&
      expiresInSeconds > ACTOR_TOKEN_EXPIRY_MARGIN_SECONDS
    ) {
      this.actorTokenCache.set(
        cacheKey,
        accessToken,
        (expiresInSeconds - ACTOR_TOKEN_EXPIRY_MARGIN_SECONDS) * 1000,
      );
    }
    return accessToken;
  }
}

export const rfc8693TokenExchangeStrategy = new Rfc8693TokenExchangeStrategy();

function mapRequestedTokenType(
  credentialType: EnterpriseCredentialExchangeParams["enterpriseManagedConfig"]["requestedCredentialType"],
): string {
  if (credentialType === "id_jag") {
    return OAUTH_TOKEN_TYPE.IdJag;
  }

  return OAUTH_TOKEN_TYPE.AccessToken;
}
