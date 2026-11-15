// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { OAUTH_GRANT_TYPE, OAUTH_TOKEN_TYPE } from "@archestra/shared";
import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import type { EnterpriseManagedCredentialType } from "@/types";
import {
  authenticateTokenRequest,
  resolveAgentClient,
  resolveIdentityProviderClient,
} from "../client-authentication";
import {
  assertAgentIdentityRequirement,
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";

const OKTA_SECRET_TOKEN_TYPE = "urn:okta:params:oauth:token-type:secret";
const OKTA_SERVICE_ACCOUNT_TOKEN_TYPE =
  "urn:okta:params:oauth:token-type:service-account";

class OktaManagedCredentialExchangeStrategy
  implements EnterpriseCredentialExchangeStrategy
{
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

    assertAgentIdentityRequirement({
      agentIdentity: params.agentIdentity,
      requireAgentIdentity:
        enterpriseConfig.agentIdentity?.requireAgentIdentity,
    });

    const tokenEndpoint =
      enterpriseConfig.tokenEndpoint ??
      params.identityProvider.oidcConfig?.tokenEndpoint ??
      (await discoverOidcTokenEndpoint(params.identityProvider.issuer)) ??
      buildDefaultOktaTokenEndpoint(params.identityProvider.issuer);
    if (!tokenEndpoint) {
      throw new Error(
        "Unable to determine managed-resource token exchange endpoint",
      );
    }

    const requestBody = new URLSearchParams({
      grant_type: OAUTH_GRANT_TYPE.TokenExchange,
      requested_token_type: mapRequestedTokenType(
        params.enterpriseManagedConfig.requestedCredentialType,
      ),
      subject_token: params.assertion,
      subject_token_type:
        enterpriseConfig.subjectTokenType ?? OAUTH_TOKEN_TYPE.IdToken,
    });

    if (params.enterpriseManagedConfig.resourceIdentifier) {
      requestBody.set(
        "resource",
        params.enterpriseManagedConfig.resourceIdentifier,
      );
    }

    if (params.enterpriseManagedConfig.audience) {
      requestBody.set("audience", params.enterpriseManagedConfig.audience);
    }

    if (params.enterpriseManagedConfig.scopes?.length) {
      requestBody.set("scope", params.enterpriseManagedConfig.scopes.join(" "));
    }

    // An Okta AI agent is its own OAuth client: the exchange runs as the
    // agent, so Okta checks the agent's delegation link and connections and
    // names the agent in what it issues.
    const agentClientId = params.agentIdentity?.externalId ?? null;
    const headers = await authenticateTokenRequest({
      client: agentClientId
        ? resolveAgentClient({
            agentIdentityConfig: enterpriseConfig.agentIdentity,
            agentClientId,
            tokenEndpoint,
          })
        : resolveIdentityProviderClient({
            identityProvider: params.identityProvider,
            tokenEndpoint,
            defaultMethod: "private_key_jwt",
          }),
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
        "Enterprise-managed managed-resource token exchange failed",
      );
      throw new Error(
        extractProviderErrorMessage(responseBody) ??
          "Enterprise-managed credential exchange failed",
      );
    }

    const credential = normalizeOktaCredentialResponse({
      responseBody,
      requestedCredentialType:
        params.enterpriseManagedConfig.requestedCredentialType ??
        "bearer_token",
    });
    return agentClientId
      ? {
          ...credential,
          issuedTo: { clientId: agentClientId, clientType: "okta_ai_agent" },
        }
      : credential;
  }
}

export const oktaManagedCredentialExchangeStrategy =
  new OktaManagedCredentialExchangeStrategy();

function buildDefaultOktaTokenEndpoint(issuer: string): string | null {
  try {
    const url = new URL(issuer);
    return `${url.origin}/oauth2/v1/token`;
  } catch {
    return null;
  }
}

function mapRequestedTokenType(
  credentialType: EnterpriseManagedCredentialType | undefined,
): string {
  switch (credentialType) {
    case "id_jag":
      return OAUTH_TOKEN_TYPE.IdJag;
    case "secret":
      return OKTA_SECRET_TOKEN_TYPE;
    case "service_account":
      return OKTA_SERVICE_ACCOUNT_TOKEN_TYPE;
    default:
      return OAUTH_TOKEN_TYPE.AccessToken;
  }
}

function normalizeOktaCredentialResponse(params: {
  responseBody: Record<string, unknown>;
  requestedCredentialType: EnterpriseManagedCredentialType;
}): EnterpriseManagedCredentialResult {
  const expiresInSeconds =
    typeof params.responseBody.expires_in === "number"
      ? params.responseBody.expires_in
      : null;
  const issuedTokenType =
    typeof params.responseBody.issued_token_type === "string"
      ? params.responseBody.issued_token_type
      : null;

  if (
    typeof params.responseBody.access_token === "string" &&
    params.responseBody.access_token.length > 0
  ) {
    return {
      credentialType: params.requestedCredentialType,
      expiresInSeconds,
      value: params.responseBody.access_token,
      issuedTokenType,
    };
  }

  if (isRecord(params.responseBody.secret)) {
    return {
      credentialType: "secret",
      expiresInSeconds,
      value: params.responseBody.secret,
      issuedTokenType,
    };
  }

  if (isRecord(params.responseBody.service_account)) {
    return {
      credentialType: "service_account",
      expiresInSeconds,
      value: params.responseBody.service_account,
      issuedTokenType,
    };
  }

  return {
    credentialType: "opaque_json",
    expiresInSeconds,
    value: params.responseBody,
    issuedTokenType,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
