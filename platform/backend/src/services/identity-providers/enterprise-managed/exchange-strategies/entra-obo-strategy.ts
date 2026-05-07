import { createPrivateKey, randomUUID } from "node:crypto";
import {
  OAUTH_CLIENT_ASSERTION_TYPE,
  OAUTH_GRANT_TYPE,
  OAUTH_TOKEN_TYPE,
} from "@shared";
import { importPKCS8, SignJWT } from "jose";
import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import {
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";

class EntraOboStrategy implements EnterpriseCredentialExchangeStrategy {
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
      throw new Error("Unable to determine Entra OBO token endpoint");
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
      grant_type: OAUTH_GRANT_TYPE.JwtBearer,
      requested_token_use: "on_behalf_of",
      assertion: params.assertion,
    });
    requestBody.set("scope", resolveScope(params.enterpriseManagedConfig));

    const headers = await buildAuthenticatedHeaders({
      clientId,
      clientSecret:
        enterpriseConfig.clientSecret ??
        params.identityProvider.oidcConfig?.clientSecret,
      tokenEndpoint,
      tokenEndpointAuthentication:
        enterpriseConfig.tokenEndpointAuthentication ?? "client_secret_post",
      requestBody,
      privateKeyId: enterpriseConfig.privateKeyId,
      privateKeyPem: enterpriseConfig.privateKeyPem,
      clientAssertionAudience:
        enterpriseConfig.clientAssertionAudience ?? tokenEndpoint,
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
        "Enterprise-managed Entra OBO exchange failed",
      );
      throw new Error(
        extractProviderErrorMessage(responseBody) ??
          "Enterprise-managed credential exchange failed",
      );
    }

    const accessToken = responseBody.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new Error("Entra OBO exchange did not return an access token");
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
    };
  }
}

export const entraOboStrategy = new EntraOboStrategy();

async function buildAuthenticatedHeaders(params: {
  clientAssertionAudience: string;
  clientId: string;
  clientSecret?: string;
  privateKeyId?: string;
  privateKeyPem?: string;
  requestBody: URLSearchParams;
  tokenEndpoint: string;
  tokenEndpointAuthentication:
    | "client_secret_post"
    | "client_secret_basic"
    | "private_key_jwt";
}): Promise<Headers> {
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

  if (params.tokenEndpointAuthentication !== "private_key_jwt") {
    throw new Error(
      `Unsupported enterprise-managed token endpoint auth method: ${params.tokenEndpointAuthentication}`,
    );
  }

  if (!params.privateKeyPem) {
    throw new Error(
      "Enterprise-managed credential exchange private key is missing",
    );
  }

  const algorithm = inferPrivateKeyAlgorithm(params.privateKeyPem);

  params.requestBody.set(
    "client_assertion_type",
    OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
  );
  params.requestBody.set(
    "client_assertion",
    await new SignJWT({})
      .setProtectedHeader({
        alg: algorithm,
        ...(params.privateKeyId ? { kid: params.privateKeyId } : {}),
      })
      .setIssuer(params.clientId)
      .setSubject(params.clientId)
      .setAudience(params.clientAssertionAudience)
      .setIssuedAt()
      .setJti(randomUUID())
      .setExpirationTime("5m")
      .sign(await importPKCS8(params.privateKeyPem, algorithm)),
  );

  return headers;
}

function resolveScope(
  enterpriseManagedConfig: EnterpriseCredentialExchangeParams["enterpriseManagedConfig"],
): string {
  if (enterpriseManagedConfig.scopes?.length) {
    return enterpriseManagedConfig.scopes.join(" ");
  }

  const resource =
    enterpriseManagedConfig.resourceIdentifier ??
    enterpriseManagedConfig.audience;
  if (!resource) {
    throw new Error(
      "Entra OBO exchange requires scopes or a resourceIdentifier/audience",
    );
  }

  // resourceIdentifier/audience are treated as Entra resource identifiers here,
  // not literal scope strings. Callers that need custom scopes must set scopes.
  if (resource.endsWith("/.default")) {
    return resource;
  }

  return `${resource.replace(/\/$/, "")}/.default`;
}

function inferPrivateKeyAlgorithm(privateKeyPem: string): "RS256" | "ES256" {
  const keyObject = createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType === "rsa") {
    return "RS256";
  }

  return "ES256";
}
