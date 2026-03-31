import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import {
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";

const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

class StandardTokenExchangeStrategy
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

    const tokenEndpoint =
      enterpriseConfig.tokenEndpoint ??
      params.identityProvider.oidcConfig?.tokenEndpoint ??
      (await discoverOidcTokenEndpoint(params.identityProvider.issuer));
    if (!tokenEndpoint) {
      throw new Error("Unable to determine standard token exchange endpoint");
    }

    const clientId =
      enterpriseConfig.clientId ?? params.identityProvider.oidcConfig?.clientId;
    if (!clientId) {
      throw new Error(
        "Enterprise-managed credential exchange client ID is missing",
      );
    }

    const requestBody = new URLSearchParams({
      client_id: clientId,
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      requested_token_type: ACCESS_TOKEN_TYPE,
      subject_token: params.assertion,
      subject_token_type:
        enterpriseConfig.subjectTokenType ?? ACCESS_TOKEN_TYPE,
    });

    const targetAudience =
      params.enterpriseManagedConfig.audience ??
      params.enterpriseManagedConfig.resourceIdentifier;
    if (targetAudience) {
      requestBody.set("audience", targetAudience);
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

    const headers = buildAuthenticatedHeaders({
      clientId,
      clientSecret:
        enterpriseConfig.clientSecret ??
        params.identityProvider.oidcConfig?.clientSecret,
      tokenEndpointAuthentication:
        enterpriseConfig.tokenEndpointAuthentication ?? "client_secret_post",
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
          body: responseBody,
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
      credentialType: "bearer_token",
      expiresInSeconds:
        typeof responseBody.expires_in === "number"
          ? responseBody.expires_in
          : null,
      value: accessToken,
      issuedTokenType:
        typeof responseBody.issued_token_type === "string"
          ? responseBody.issued_token_type
          : ACCESS_TOKEN_TYPE,
    };
  }
}

export const standardTokenExchangeStrategy =
  new StandardTokenExchangeStrategy();

function buildAuthenticatedHeaders(params: {
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthentication:
    | "client_secret_post"
    | "client_secret_basic"
    | "private_key_jwt";
  requestBody: URLSearchParams;
}): Headers {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });

  if (params.tokenEndpointAuthentication === "client_secret_basic") {
    if (!params.clientSecret) {
      throw new Error(
        "Enterprise-managed credential exchange client secret is missing",
      );
    }
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${params.clientId}:${params.clientSecret}`).toString("base64")}`,
    );
    return headers;
  }

  if (params.tokenEndpointAuthentication === "client_secret_post") {
    if (!params.clientSecret) {
      throw new Error(
        "Enterprise-managed credential exchange client secret is missing",
      );
    }
    params.requestBody.set("client_secret", params.clientSecret);
    return headers;
  }

  throw new Error(
    "Standard token exchange does not support private_key_jwt in this implementation",
  );
}
