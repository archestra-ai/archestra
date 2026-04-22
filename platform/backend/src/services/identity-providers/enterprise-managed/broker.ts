import type { TokenAuthContext } from "@/clients/mcp-client";
import logger from "@/logging";
import { resolveEnterpriseAssertion } from "@/services/identity-providers/enterprise-managed/assertion-resolver";
import {
  type EnterpriseManagedCredentialResult,
  exchangeEnterpriseManagedCredential,
  extractProviderErrorMessage,
} from "@/services/identity-providers/enterprise-managed/exchange";
import { findExternalIdentityProviderById } from "@/services/identity-providers/oidc";
import type { EnterpriseManagedCredentialConfig } from "@/types";

export type ResolvedEnterpriseTransportCredential = {
  headerName: string;
  headerValue: string;
  expiresInSeconds: number | null;
};

const JWT_BEARER_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

export async function resolveEnterpriseTransportCredential(params: {
  agentId: string;
  tokenAuth?: TokenAuthContext;
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig | null;
}): Promise<ResolvedEnterpriseTransportCredential | null> {
  const config = params.enterpriseManagedConfig;
  if (!config) {
    return null;
  }

  const assertion = await resolveEnterpriseAssertion({
    agentId: params.agentId,
    identityProviderId: config.identityProviderId,
    tokenAuth: params.tokenAuth,
  });
  if (!assertion) {
    logger.warn(
      {
        agentId: params.agentId,
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
    const credential = await exchangeIdJagAtProtectedResource({
      assertion: assertion.assertion,
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
  });

  return normalizeEnterpriseTransportCredential({
    config,
    credential,
  });
}

async function exchangeIdJagAtProtectedResource(params: {
  assertion: string;
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
  const enterpriseConfig =
    identityProvider?.oidcConfig?.enterpriseManagedCredentials;
  const clientId =
    params.enterpriseManagedConfig.clientIdOverride ??
    enterpriseConfig?.clientId ??
    identityProvider?.oidcConfig?.clientId;
  if (!clientId) {
    throw new Error("ID-JAG protected resource exchange client ID is missing");
  }

  const tokenEndpoint =
    await discoverProtectedResourceTokenEndpoint(resourceIdentifier);
  const requestBody = new URLSearchParams({
    grant_type: JWT_BEARER_GRANT_TYPE,
    assertion: params.assertion,
  });
  const headers = buildProtectedResourceTokenHeaders({
    clientId,
    clientSecret:
      enterpriseConfig?.clientSecret ??
      identityProvider?.oidcConfig?.clientSecret,
    tokenEndpointAuthentication:
      enterpriseConfig?.tokenEndpointAuthentication ?? "client_secret_basic",
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
        : ACCESS_TOKEN_TYPE,
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

function buildProtectedResourceTokenHeaders(params: {
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
        "ID-JAG protected resource exchange client secret is missing",
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
        "ID-JAG protected resource exchange client secret is missing",
      );
    }
    params.requestBody.set("client_id", params.clientId);
    params.requestBody.set("client_secret", params.clientSecret);
    return headers;
  }

  throw new Error(
    "ID-JAG protected resource exchange does not support private_key_jwt in this implementation",
  );
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

  switch (config.tokenInjectionMode) {
    case "header":
      if (!config.headerName) {
        throw new Error(
          "Enterprise-managed credential injection mode 'header' requires headerName",
        );
      }
      return {
        headerName: config.headerName,
        headerValue: scalarValue,
        expiresInSeconds: credential.expiresInSeconds,
      };
    case "raw_authorization":
      return {
        headerName: "Authorization",
        headerValue: scalarValue,
        expiresInSeconds: credential.expiresInSeconds,
      };
    default:
      return {
        headerName: "Authorization",
        headerValue: `Bearer ${scalarValue}`,
        expiresInSeconds: credential.expiresInSeconds,
      };
  }
}

function normalizeEnterprisePassthroughCredential(params: {
  config: EnterpriseManagedCredentialConfig;
  assertion: string;
}): ResolvedEnterpriseTransportCredential {
  switch (params.config.tokenInjectionMode) {
    case "header":
      if (!params.config.headerName) {
        throw new Error(
          "Enterprise-managed credential injection mode 'header' requires headerName",
        );
      }
      return {
        headerName: params.config.headerName,
        headerValue: params.assertion,
        expiresInSeconds: null,
      };
    case "raw_authorization":
      return {
        headerName: "Authorization",
        headerValue: params.assertion,
        expiresInSeconds: null,
      };
    default:
      return {
        headerName: "Authorization",
        headerValue: `Bearer ${params.assertion}`,
        expiresInSeconds: null,
      };
  }
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
