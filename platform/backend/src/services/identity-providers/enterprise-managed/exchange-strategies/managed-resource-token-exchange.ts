import { createPrivateKey, randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import logger from "@/logging";
import { discoverOidcTokenEndpoint } from "@/services/identity-providers/oidc";
import type { EnterpriseManagedCredentialType } from "@/types";
import {
  type EnterpriseCredentialExchangeParams,
  type EnterpriseCredentialExchangeStrategy,
  type EnterpriseManagedCredentialResult,
  extractProviderErrorMessage,
} from "../exchange";

const TOKEN_EXCHANGE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const CLIENT_ASSERTION_TYPE =
  "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";
const ID_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id_token";
const ID_JAG_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:id-jag";
const OKTA_SECRET_TOKEN_TYPE = "urn:okta:params:oauth:token-type:secret";
const OKTA_SERVICE_ACCOUNT_TOKEN_TYPE =
  "urn:okta:params:oauth:token-type:service-account";

class ManagedResourceTokenExchangeStrategy
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
      (await discoverOidcTokenEndpoint(params.identityProvider.issuer)) ??
      buildDefaultOktaTokenEndpoint(params.identityProvider.issuer);
    if (!tokenEndpoint) {
      throw new Error(
        "Unable to determine managed-resource token exchange endpoint",
      );
    }

    const clientId =
      enterpriseConfig.clientId ?? params.identityProvider.oidcConfig?.clientId;
    if (!clientId) {
      throw new Error(
        "Enterprise-managed credential exchange client ID is missing",
      );
    }

    const requestBody = new URLSearchParams({
      grant_type: TOKEN_EXCHANGE_GRANT_TYPE,
      requested_token_type: mapRequestedTokenType(
        params.enterpriseManagedConfig.requestedCredentialType,
      ),
      subject_token: params.assertion,
      subject_token_type: enterpriseConfig.subjectTokenType ?? ID_TOKEN_TYPE,
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

    const requestInit = await this.buildAuthenticatedRequest({
      clientId,
      tokenEndpoint,
      requestBody,
      enterpriseConfig,
    });

    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: requestInit.headers,
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

    return normalizeOktaCredentialResponse({
      responseBody,
      requestedCredentialType:
        params.enterpriseManagedConfig.requestedCredentialType ??
        "bearer_token",
    });
  }

  private async buildAuthenticatedRequest(params: {
    clientId: string;
    tokenEndpoint: string;
    requestBody: URLSearchParams;
    enterpriseConfig: NonNullable<
      NonNullable<
        EnterpriseCredentialExchangeParams["identityProvider"]["oidcConfig"]
      >["enterpriseManagedCredentials"]
    >;
  }): Promise<{ headers: Headers }> {
    const tokenEndpointAuthentication =
      params.enterpriseConfig.tokenEndpointAuthentication ?? "private_key_jwt";
    const headers = new Headers({
      "Content-Type": "application/x-www-form-urlencoded",
    });

    if (tokenEndpointAuthentication === "client_secret_basic") {
      const clientSecret = params.enterpriseConfig.clientSecret;
      if (!clientSecret) {
        throw new Error(
          "Enterprise-managed credential exchange client secret is missing",
        );
      }
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${params.clientId}:${clientSecret}`).toString("base64")}`,
      );
      return { headers };
    }

    if (tokenEndpointAuthentication === "client_secret_post") {
      const clientSecret = params.enterpriseConfig.clientSecret;
      if (!clientSecret) {
        throw new Error(
          "Enterprise-managed credential exchange client secret is missing",
        );
      }
      params.requestBody.set("client_id", params.clientId);
      params.requestBody.set("client_secret", clientSecret);
      return { headers };
    }

    if (tokenEndpointAuthentication !== "private_key_jwt") {
      throw new Error(
        `Unsupported enterprise-managed token endpoint auth method: ${tokenEndpointAuthentication}`,
      );
    }

    const privateKeyPem = params.enterpriseConfig.privateKeyPem;
    if (!privateKeyPem) {
      throw new Error(
        "Enterprise-managed credential exchange private key is missing",
      );
    }

    params.requestBody.set("client_id", params.clientId);
    params.requestBody.set("client_assertion_type", CLIENT_ASSERTION_TYPE);
    params.requestBody.set(
      "client_assertion",
      await buildClientAssertion({
        clientId: params.clientId,
        tokenEndpoint: params.tokenEndpoint,
        privateKeyPem,
        privateKeyId: params.enterpriseConfig.privateKeyId,
        audience:
          params.enterpriseConfig.clientAssertionAudience ??
          params.tokenEndpoint,
      }),
    );

    return { headers };
  }
}

export const managedResourceTokenExchangeStrategy =
  new ManagedResourceTokenExchangeStrategy();

async function buildClientAssertion(params: {
  clientId: string;
  tokenEndpoint: string;
  privateKeyPem: string;
  privateKeyId?: string;
  audience: string;
}): Promise<string> {
  const algorithm = inferPrivateKeyAlgorithm(params.privateKeyPem);
  const key = await importPKCS8(params.privateKeyPem, algorithm);

  return new SignJWT({})
    .setProtectedHeader({
      alg: algorithm,
      ...(params.privateKeyId ? { kid: params.privateKeyId } : {}),
    })
    .setIssuer(params.clientId)
    .setSubject(params.clientId)
    .setAudience(params.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime("5m")
    .sign(key);
}

function inferPrivateKeyAlgorithm(privateKeyPem: string): "RS256" | "ES256" {
  const keyObject = createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType === "rsa") {
    return "RS256";
  }

  return "ES256";
}

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
      return ID_JAG_TOKEN_TYPE;
    case "secret":
      return OKTA_SECRET_TOKEN_TYPE;
    case "service_account":
      return OKTA_SERVICE_ACCOUNT_TOKEN_TYPE;
    default:
      return ACCESS_TOKEN_TYPE;
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
