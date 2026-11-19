// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
import { createPrivateKey, randomUUID } from "node:crypto";
import {
  type AgentIdentityConfig,
  OAUTH_CLIENT_ASSERTION_TYPE,
} from "@archestra/shared";
import { importPKCS8, SignJWT } from "jose";
import type { ExternalIdentityProviderConfig } from "@/services/identity-providers/oidc";
import { ApiError, type EnterpriseManagedCredentialConfig } from "@/types";

/** How a client authenticates to an identity provider's token endpoint. */
export type TokenEndpointClientAuth =
  | {
      method: "client_secret_post" | "client_secret_basic";
      clientSecret?: string;
    }
  | {
      method: "private_key_jwt";
      privateKeyPem?: string;
      privateKeyId?: string;
      clientAssertionAudience: string;
    }
  | { method: "client_assertion"; clientAssertion: string };

export type TokenEndpointClient = {
  clientId: string;
  auth: TokenEndpointClientAuth;
};

type TokenEndpointAuthMethod =
  | "client_secret_post"
  | "client_secret_basic"
  | "private_key_jwt";

/**
 * Adds the client's credentials to a form-encoded token request, and returns
 * the headers to send it with. Every method but `client_secret_basic` also
 * names the client in the body, as RFC 7523 and Okta expect.
 */
export async function authenticateTokenRequest(params: {
  client: TokenEndpointClient;
  requestBody: URLSearchParams;
}): Promise<Headers> {
  const headers = new Headers({
    "Content-Type": "application/x-www-form-urlencoded",
  });
  const { auth, clientId } = params.client;

  switch (auth.method) {
    case "client_secret_basic":
      headers.set(
        "Authorization",
        `Basic ${Buffer.from(`${clientId}:${requireClientSecret(auth.clientSecret)}`).toString("base64")}`,
      );
      return headers;
    case "client_secret_post":
      params.requestBody.set("client_id", clientId);
      params.requestBody.set(
        "client_secret",
        requireClientSecret(auth.clientSecret),
      );
      return headers;
    case "client_assertion":
      params.requestBody.set("client_id", clientId);
      params.requestBody.set(
        "client_assertion_type",
        OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
      );
      params.requestBody.set("client_assertion", auth.clientAssertion);
      return headers;
    case "private_key_jwt":
      if (!auth.privateKeyPem) {
        throw new Error(
          "Enterprise-managed credential exchange private key is missing",
        );
      }
      params.requestBody.set("client_id", clientId);
      params.requestBody.set(
        "client_assertion_type",
        OAUTH_CLIENT_ASSERTION_TYPE.JwtBearer,
      );
      params.requestBody.set(
        "client_assertion",
        await signClientAssertion({
          clientId,
          privateKeyPem: auth.privateKeyPem,
          privateKeyId: auth.privateKeyId,
          audience: auth.clientAssertionAudience,
        }),
      );
      return headers;
    default:
      throw new Error(
        `Unsupported enterprise-managed token endpoint auth method: ${(auth as { method: string }).method}`,
      );
  }
}

/**
 * The identity provider's own exchange client, from its Tool Access
 * settings, falling back to the sign-in client.
 */
export function resolveIdentityProviderClient(params: {
  identityProvider: ExternalIdentityProviderConfig;
  tokenEndpoint: string;
  defaultMethod: TokenEndpointAuthMethod;
}): TokenEndpointClient {
  const oidcConfig = params.identityProvider.oidcConfig;
  const enterpriseConfig = oidcConfig?.enterpriseManagedCredentials;
  const clientId = enterpriseConfig?.clientId ?? oidcConfig?.clientId;
  if (!clientId) {
    throw new Error(
      "Enterprise-managed credential exchange client ID is missing",
    );
  }

  const method =
    enterpriseConfig?.tokenEndpointAuthentication ?? params.defaultMethod;
  if (method === "private_key_jwt") {
    return {
      clientId,
      auth: {
        method,
        privateKeyPem: enterpriseConfig?.privateKeyPem,
        privateKeyId: enterpriseConfig?.privateKeyId,
        clientAssertionAudience:
          enterpriseConfig?.clientAssertionAudience ?? params.tokenEndpoint,
      },
    };
  }

  return {
    clientId,
    auth: {
      method,
      clientSecret: enterpriseConfig?.clientSecret ?? oidcConfig?.clientSecret,
    },
  };
}

/**
 * The MCP server's own exchange client (`clientIdOverride`), or null when the
 * server uses the identity provider's.
 */
export function resolveServerOverrideClient(params: {
  enterpriseManagedConfig: EnterpriseManagedCredentialConfig;
  tokenEndpoint: string;
  /** How the override's client secret is sent, when it has no private key. */
  secretMethod: "client_secret_post" | "client_secret_basic";
}): TokenEndpointClient | null {
  const config = params.enterpriseManagedConfig;
  const clientId = config.clientIdOverride?.trim();
  if (!clientId) {
    return null;
  }

  if (config.privateKeyPemOverride) {
    return {
      clientId,
      auth: {
        method: "private_key_jwt",
        privateKeyPem: config.privateKeyPemOverride,
        privateKeyId: config.privateKeyIdOverride,
        clientAssertionAudience: params.tokenEndpoint,
      },
    };
  }

  if (!config.clientSecretOverride) {
    throw new ApiError(
      400,
      "This MCP server overrides the token exchange client, but has no client secret or private key for it. Add one under the server's Exchange Client settings.",
    );
  }

  return {
    clientId,
    auth: {
      method: params.secretMethod,
      clientSecret: config.clientSecretOverride,
    },
  };
}

/**
 * The calling agent's own client at the identity provider, authenticated with
 * the provider's agent identity key.
 */
export function resolveAgentClient(params: {
  agentIdentityConfig: AgentIdentityConfig | undefined;
  agentClientId: string;
  tokenEndpoint: string;
}): TokenEndpointClient {
  const privateKeyPem = params.agentIdentityConfig?.privateKeyPem;
  if (!privateKeyPem) {
    throw new ApiError(
      400,
      "This agent is bound to an identity at this identity provider, but the identity provider has no agent identity key. Add one under Tool Access → Agent Identities, or remove the agent's binding.",
    );
  }

  return {
    clientId: params.agentClientId,
    auth: {
      method: "private_key_jwt",
      privateKeyPem,
      privateKeyId: params.agentIdentityConfig?.privateKeyId,
      clientAssertionAudience: params.tokenEndpoint,
    },
  };
}

// === Internal helpers ===

const SHA1_THUMBPRINT_PATTERN = /^[0-9a-f]{40}$/i;

function requireClientSecret(clientSecret: string | undefined): string {
  if (!clientSecret) {
    throw new Error(
      "Enterprise-managed credential exchange client secret is missing",
    );
  }
  return clientSecret;
}

async function signClientAssertion(params: {
  clientId: string;
  privateKeyPem: string;
  privateKeyId?: string;
  audience: string;
}): Promise<string> {
  const algorithm = inferPrivateKeyAlgorithm(params.privateKeyPem);
  const keyId = params.privateKeyId?.trim();
  return new SignJWT({})
    .setProtectedHeader({
      alg: algorithm,
      ...(keyId ? { kid: keyId } : {}),
      // Entra identifies a certificate credential by its SHA-1 thumbprint in
      // `x5t`; the portal shows the thumbprint as 40 hex characters.
      ...(keyId && SHA1_THUMBPRINT_PATTERN.test(keyId)
        ? { x5t: Buffer.from(keyId, "hex").toString("base64url") }
        : {}),
    })
    .setIssuer(params.clientId)
    .setSubject(params.clientId)
    .setAudience(params.audience)
    .setIssuedAt()
    .setJti(randomUUID())
    .setExpirationTime("5m")
    .sign(await importPKCS8(params.privateKeyPem, algorithm));
}

function inferPrivateKeyAlgorithm(privateKeyPem: string): "RS256" | "ES256" {
  const keyObject = createPrivateKey(privateKeyPem);
  if (keyObject.asymmetricKeyType === "rsa") {
    return "RS256";
  }

  return "ES256";
}
