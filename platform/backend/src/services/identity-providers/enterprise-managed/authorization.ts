import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OAUTH_SCOPES } from "@shared";
import { decodeProtectedHeader } from "jose";
import config from "@/config";
import {
  AgentModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  UserModel,
} from "@/models";
import {
  discoverOidcJwksUrl,
  findExternalIdentityProviderById,
} from "@/services/identity-providers/oidc";
import { jwksValidator } from "@/services/jwks-validator";

export const JWT_BEARER_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:jwt-bearer";
export const OAUTH_ID_JAG_TYP = "oauth-id-jag+jwt";
export const MCP_RESOURCE_REFERENCE_PREFIX = "mcp-resource:";

export interface EnterpriseManagedTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
}

export interface OAuthTokenErrorResponse {
  error:
    | "invalid_client"
    | "invalid_grant"
    | "invalid_request"
    | "invalid_scope";
  error_description: string;
}

export async function exchangeIdentityAssertionForAccessToken(params: {
  assertion: string | undefined;
  clientId: string | undefined;
  clientSecret: string | undefined;
}): Promise<
  | { ok: true; body: EnterpriseManagedTokenResponse }
  | { ok: false; statusCode: 400 | 401; body: OAuthTokenErrorResponse }
> {
  if (!params.assertion) {
    return invalidRequest("Missing assertion parameter.");
  }

  if (!params.clientId) {
    return invalidClient("Missing client authentication.");
  }

  const client = await OAuthClientModel.findByClientId(params.clientId);
  if (!client) {
    return invalidClient("Unknown OAuth client.");
  }

  const clientAuthError = validateClientAuthentication({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    registeredClientSecret: client.clientSecret ?? undefined,
    tokenEndpointAuthMethod: client.tokenEndpointAuthMethod ?? undefined,
  });
  if (clientAuthError) {
    return clientAuthError;
  }

  const assertionMetadata = readAssertionMetadata(params.assertion);
  if (!assertionMetadata) {
    return invalidGrant("Assertion must be a valid JWT.");
  }

  if (assertionMetadata.typ !== OAUTH_ID_JAG_TYP) {
    return invalidGrant(`Assertion JWT typ must be "${OAUTH_ID_JAG_TYP}".`);
  }

  if (!assertionMetadata.issuer) {
    return invalidGrant("Assertion JWT is missing the iss claim.");
  }

  if (!assertionMetadata.resource) {
    return invalidGrant("Assertion JWT is missing the resource claim.");
  }

  if (assertionMetadata.clientId !== params.clientId) {
    return invalidGrant(
      "Assertion JWT client_id does not match the authenticated OAuth client.",
    );
  }

  const profileId = extractProfileIdFromResource(assertionMetadata.resource);
  if (!profileId) {
    return invalidGrant(
      "Assertion JWT resource must reference a valid MCP Gateway URL.",
    );
  }

  const agent = await AgentModel.findById(profileId);
  if (!agent?.identityProviderId) {
    return invalidGrant(
      "The target MCP Gateway does not have an external identity provider configured.",
    );
  }

  const identityProvider = await findExternalIdentityProviderById(
    agent.identityProviderId,
  );
  if (!identityProvider?.oidcConfig) {
    return invalidGrant(
      "The configured identity provider must be an OIDC provider.",
    );
  }

  const jwksUrl =
    identityProvider.oidcConfig.jwksEndpoint ??
    (await discoverOidcJwksUrl(identityProvider.issuer));
  if (!jwksUrl) {
    return invalidGrant("Unable to determine the identity provider JWKS URL.");
  }

  const validationResult = await jwksValidator.validateJwt({
    token: params.assertion,
    issuerUrl: identityProvider.issuer,
    jwksUrl,
    audience: buildOAuthIssuer(),
  });
  if (!validationResult) {
    return invalidGrant("Assertion JWT validation failed.");
  }

  if (!validationResult.email) {
    return invalidGrant(
      "Assertion JWT must include an email claim to link to an Archestra user.",
    );
  }

  const user = await UserModel.findByEmail(validationResult.email);
  if (!user) {
    return invalidGrant(
      "Assertion JWT email does not match any Archestra user.",
    );
  }

  const normalizedScopes = normalizeAssertionScopes(assertionMetadata.scope);
  if (!normalizedScopes.includes("mcp")) {
    return invalidScope('Assertion JWT scope must include the "mcp" scope.');
  }

  const accessToken = randomBytes(32).toString("base64url");
  const accessTokenHash = createHash("sha256")
    .update(accessToken)
    .digest("base64url");
  const expiresInSeconds = 3600;

  await OAuthAccessTokenModel.create({
    tokenHash: accessTokenHash,
    clientId: client.clientId,
    userId: user.id,
    expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    scopes: ["mcp"],
    referenceId: `${MCP_RESOURCE_REFERENCE_PREFIX}${profileId}`,
  });

  return {
    ok: true,
    body: {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: expiresInSeconds,
      scope: "mcp",
    },
  };
}

export function buildOAuthIssuer(): string {
  return config.frontendBaseUrl.endsWith("/")
    ? config.frontendBaseUrl
    : `${config.frontendBaseUrl}/`;
}

// =============================================================================
// Internal helpers
// =============================================================================

function validateClientAuthentication(params: {
  clientId: string;
  clientSecret: string | undefined;
  registeredClientSecret: string | undefined;
  tokenEndpointAuthMethod: string | undefined;
}): { ok: false; statusCode: 401; body: OAuthTokenErrorResponse } | null {
  const authMethod = params.tokenEndpointAuthMethod ?? "none";

  if (authMethod === "none") {
    return null;
  }

  if (
    (authMethod === "client_secret_basic" ||
      authMethod === "client_secret_post") &&
    hasMatchingClientSecret({
      registeredClientSecret: params.registeredClientSecret,
      clientSecret: params.clientSecret,
    })
  ) {
    return null;
  }

  return invalidClient("OAuth client authentication failed.");
}

function readAssertionMetadata(assertion: string): {
  typ: string | null;
  issuer: string | null;
  clientId: string | null;
  resource: string | null;
  scope: string | null;
} | null {
  try {
    const header = decodeProtectedHeader(assertion);
    const [, payload] = assertion.split(".");
    if (!payload) {
      return null;
    }

    const decodedPayload = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as Record<string, unknown>;

    return {
      typ: typeof header.typ === "string" ? header.typ : null,
      issuer: extractString(decodedPayload, "iss"),
      clientId: extractString(decodedPayload, "client_id"),
      resource: extractString(decodedPayload, "resource"),
      scope: extractString(decodedPayload, "scope"),
    };
  } catch {
    return null;
  }
}

function extractProfileIdFromResource(resource: string): string | null {
  try {
    const resourceUrl = new URL(resource);
    const issuerUrl = new URL(buildOAuthIssuer());
    if (resourceUrl.origin !== issuerUrl.origin) {
      return null;
    }

    const { pathname } = resourceUrl;
    const match = pathname.match(/^\/v1\/mcp\/([0-9a-f-]{36})$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function normalizeAssertionScopes(scope: string | null): string[] {
  if (!scope) {
    return [];
  }

  const supportedScopes = new Set<string>(OAUTH_SCOPES);
  return scope
    .split(/\s+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => supportedScopes.has(item));
}

function hasMatchingClientSecret(params: {
  registeredClientSecret: string | undefined;
  clientSecret: string | undefined;
}): boolean {
  if (!params.registeredClientSecret || !params.clientSecret) {
    return false;
  }

  const registeredSecret = Buffer.from(params.registeredClientSecret, "utf8");
  const providedSecret = Buffer.from(params.clientSecret, "utf8");

  if (registeredSecret.length !== providedSecret.length) {
    return false;
  }

  return timingSafeEqual(registeredSecret, providedSecret);
}

function extractString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

function invalidClient(errorDescription: string): {
  ok: false;
  statusCode: 401;
  body: OAuthTokenErrorResponse;
} {
  return {
    ok: false,
    statusCode: 401,
    body: {
      error: "invalid_client",
      error_description: errorDescription,
    },
  };
}

function invalidGrant(errorDescription: string): {
  ok: false;
  statusCode: 400;
  body: OAuthTokenErrorResponse;
} {
  return {
    ok: false,
    statusCode: 400,
    body: {
      error: "invalid_grant",
      error_description: errorDescription,
    },
  };
}

function invalidRequest(errorDescription: string): {
  ok: false;
  statusCode: 400;
  body: OAuthTokenErrorResponse;
} {
  return {
    ok: false,
    statusCode: 400,
    body: {
      error: "invalid_request",
      error_description: errorDescription,
    },
  };
}

function invalidScope(errorDescription: string): {
  ok: false;
  statusCode: 400;
  body: OAuthTokenErrorResponse;
} {
  return {
    ok: false,
    statusCode: 400,
    body: {
      error: "invalid_scope",
      error_description: errorDescription,
    },
  };
}
