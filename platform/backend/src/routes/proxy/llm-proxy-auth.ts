/**
 * Authentication and API key resolution for the LLM proxy handler.
 *
 * Extracted from handleLLMProxy to keep the main handler focused on
 * request/response orchestration. Each function is independently testable.
 */

import {
  hasArchestraTokenPrefix,
  isSupportedProvider,
  LLM_PROXY_OAUTH_SCOPE,
} from "@shared";
import type { FastifyRequest } from "fastify";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import {
  AgentModel,
  AgentTeamModel,
  LlmOauthClientModel,
  LlmProviderApiKeyModel,
  MemberModel,
  OAuthAccessTokenModel,
  OAuthClientModel,
  VirtualApiKeyModel,
} from "@/models";
import { validateExternalIdpToken } from "@/routes/mcp-gateway.utils";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { type Agent, ApiError } from "@/types";
import { resolveProviderApiKey } from "@/utils/llm-api-key-resolution";
import { isLoopbackAddress } from "@/utils/network";

// =========================================================================
// Agent Resolution
// =========================================================================

/**
 * Resolve the target agent from the request URL or fall back to the default profile.
 */
export async function resolveAgent(
  agentId: string | undefined,
): Promise<Agent> {
  if (agentId) {
    const agent = await AgentModel.findById(agentId);
    if (!agent) {
      throw new ApiError(404, `Agent with ID ${agentId} not found`);
    }
    return agent;
  }

  const defaultProfile = await AgentModel.getDefaultProfile();
  if (!defaultProfile) {
    throw new ApiError(400, "Please specify an LLMProxy ID in the URL path.");
  }
  return defaultProfile;
}

// =========================================================================
// Virtual API Key Validation
// =========================================================================

export interface VirtualKeyValidationResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Parent chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId: string | undefined;
}

type ResolvedVirtualApiKey = NonNullable<
  Awaited<ReturnType<typeof VirtualApiKeyModel.validateToken>>
>;

export async function validateVirtualApiKeyToken(
  tokenValue: string,
): Promise<ResolvedVirtualApiKey> {
  const resolved = await VirtualApiKeyModel.validateToken(tokenValue);
  if (!resolved) {
    throw new ApiError(401, "Invalid virtual API key");
  }

  if (
    resolved.virtualKey.expiresAt &&
    resolved.virtualKey.expiresAt < new Date()
  ) {
    throw new ApiError(401, "Virtual API key expired");
  }

  return resolved;
}

/**
 * Validate a platform-managed virtual API key.
 * Checks: token validity, expiration, and provider mapping.
 * Returns the resolved real API key and optional base URL.
 *
 * Throws ApiError on validation failure.
 */
export async function validateVirtualApiKey(
  tokenValue: string,
  expectedProvider: string,
): Promise<VirtualKeyValidationResult> {
  const resolved = await validateVirtualApiKeyToken(tokenValue);
  const mappedProviderKey = (
    await VirtualApiKeyModel.getProviderApiKeysForRouting(
      resolved.virtualKey.id,
    )
  ).find((mapping) => mapping.provider === expectedProvider);
  if (!mappedProviderKey) {
    throw new ApiError(
      400,
      `Virtual API key is not mapped to provider "${expectedProvider}".`,
    );
  }

  // Resolve the real provider API key from the secret.
  // If the parent key's secret was removed (orphaned row), apiKey will be
  // undefined. For providers that require keys, the upstream call will fail
  // with a clear error. For keyless providers the virtual key alone is
  // sufficient authentication.
  let apiKey: string | undefined;
  if (mappedProviderKey.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      mappedProviderKey.secretId,
    );
    if (secretValue) {
      apiKey = secretValue as string;
    } else {
      logger.warn(
        {
          virtualKeyId: resolved.virtualKey.id,
          chatApiKeyId: mappedProviderKey.providerApiKeyId,
          secretId: mappedProviderKey.secretId,
        },
        "Virtual key's parent chat API key secret could not be resolved (may be orphaned)",
      );
    }
  }

  return {
    apiKey,
    baseUrl: mappedProviderKey.baseUrl ?? undefined,
    chatApiKeyId: mappedProviderKey.providerApiKeyId,
  };
}

// =========================================================================
// LLM OAuth Access Token Validation
// =========================================================================

export type LlmOAuthAccessTokenValidationResult = {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  chatApiKeyId: string | undefined;
  authMethod: "oauth_client_credentials" | "oauth_user";
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
  userId?: string;
};

export async function validateLlmOAuthAccessToken(params: {
  tokenValue: string;
  expectedProvider: string;
  agent: Agent;
}): Promise<LlmOAuthAccessTokenValidationResult | null> {
  const accessToken = await OAuthAccessTokenModel.getByTokenHash(
    OAuthAccessTokenModel.hashTokenForLookup(params.tokenValue),
  );
  if (!accessToken) {
    return null;
  }
  if (accessToken.expiresAt < new Date()) {
    throw new ApiError(401, "Invalid LLM OAuth access token.");
  }
  if (accessToken.refreshTokenRevoked) {
    throw new ApiError(401, "Invalid LLM OAuth access token.");
  }
  if (!hasLlmProxyScope(accessToken.scopes)) {
    throw new ApiError(403, "Access token is missing LLM proxy scope.");
  }
  if (accessToken.userId) {
    return validateUserLlmOAuthAccessToken({
      userId: accessToken.userId,
      clientId: accessToken.clientId,
      expectedProvider: params.expectedProvider,
      agent: params.agent,
    });
  }

  return validateClientCredentialsLlmOAuthAccessToken({
    clientId: accessToken.clientId,
    expectedProvider: params.expectedProvider,
    agent: params.agent,
  });
}

// =========================================================================
// JWKS Authentication
// =========================================================================

export interface JwksAuthResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  /** Resolved chat_api_key row ID; used by the proxy to look up per-key settings (e.g. extra headers). */
  chatApiKeyId: string | undefined;
  userId: string | undefined;
  organizationId: string;
}

/**
 * Attempt JWKS authentication for agents with an external identity provider.
 * Returns null if no JWKS auth was attempted (no IdP configured, no bearer token,
 * virtual key token, or the bearer value is not shaped like a JWT).
 * Throws ApiError if the JWT is invalid.
 */
export async function attemptJwksAuth(
  request: FastifyRequest,
  resolvedAgent: Agent,
  providerName: string,
): Promise<JwksAuthResult | null> {
  if (!resolvedAgent.identityProviderId) return null;

  // Read the bearer token from the RAW request headers. We cannot use
  // extractBearerToken(request) here because some provider routes (e.g.
  // OpenAI) define a headers schema with a .transform() that strips the
  // "Bearer " prefix. After Fastify applies the schema transform,
  // request.headers.authorization no longer starts with "Bearer ", causing
  // extractBearerToken to return null and silently skipping JWKS auth.
  // Reading from request.raw.headers bypasses schema transforms.
  const rawAuthHeader = request.raw.headers.authorization;
  const tokenMatch = rawAuthHeader?.match(/^Bearer\s+(.+)$/i);
  const bearerToken = tokenMatch?.[1] ?? null;
  if (!bearerToken || hasArchestraTokenPrefix(bearerToken)) return null;
  if (!isJwtLike(bearerToken)) return null;

  let jwksResult: Awaited<ReturnType<typeof validateExternalIdpToken>>;
  try {
    jwksResult = await validateExternalIdpToken(
      resolvedAgent.id,
      bearerToken,
      "llmProxy",
    );
  } catch (error) {
    // Convert any unexpected validation error to 401 (not 500)
    logger.warn(
      {
        resolvedAgentId: resolvedAgent.id,
        error: error instanceof Error ? error.message : String(error),
      },
      `[${providerName}Proxy] JWKS validation error`,
    );
    throw new ApiError(
      401,
      "JWT validation failed for the configured identity provider.",
    );
  }

  if (!jwksResult) {
    throw new ApiError(
      401,
      "Invalid JWT token for the configured identity provider.",
    );
  }

  logger.info(
    {
      resolvedAgentId: resolvedAgent.id,
      userId: jwksResult.userId,
      identityProviderId: resolvedAgent.identityProviderId,
    },
    `[${providerName}Proxy] JWKS authentication succeeded`,
  );

  let apiKey: string | undefined;
  let baseUrl: string | undefined;
  let chatApiKeyId: string | undefined;

  if (isSupportedProvider(providerName)) {
    const resolved = await resolveProviderApiKey({
      organizationId: jwksResult.organizationId,
      userId: jwksResult.userId,
      provider: providerName,
    });
    apiKey = resolved.apiKey;
    baseUrl = resolved.baseUrl ?? undefined;
    chatApiKeyId = resolved.chatApiKeyId;
  }

  return {
    apiKey,
    baseUrl,
    chatApiKeyId,
    userId: jwksResult.userId,
    organizationId: jwksResult.organizationId,
  };
}

// =========================================================================
// Keyless Provider Check
// =========================================================================

/**
 * For keyless providers (Ollama, vLLM, Vertex AI Gemini), ensure the request
 * was authenticated via a virtual API key or JWKS. Without this, anyone who
 * knows the proxy URL could call the endpoint without credentials.
 *
 * Internal requests from localhost (chat route → proxy) are allowed.
 */
export function assertAuthenticatedForKeylessProvider(
  apiKey: string | undefined,
  wasVirtualKeyResolved: boolean,
  wasJwksAuthenticated: boolean,
  requestIp: string,
): void {
  if (apiKey || wasVirtualKeyResolved || wasJwksAuthenticated) return;

  if (!isLoopbackAddress(requestIp)) {
    throw new ApiError(
      401,
      "Authentication required. Use a platform virtual API key or pass a provider API key.",
    );
  }
}

// =========================================================================
// Virtual Key Rate Limiter
// =========================================================================

const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  count: number;
}

/**
 * Distributed rate limiter for failed virtual API key validation attempts.
 * Prevents brute-force enumeration of valid tokens by tracking failures per
 * client IP and rejecting further attempts after exceeding the threshold.
 *
 * Uses the PostgreSQL-backed CacheManager (Keyv) so rate limit state is
 * shared across all application pods. Entries expire automatically via TTL.
 */
export class VirtualKeyRateLimiter {
  private cacheManager: {
    get: <T>(key: AllowedCacheKey) => Promise<T | undefined>;
    set: <T>(
      key: AllowedCacheKey,
      value: T,
      ttl?: number,
    ) => Promise<T | undefined>;
  };

  constructor(cacheManager: {
    get: <T>(key: AllowedCacheKey) => Promise<T | undefined>;
    set: <T>(
      key: AllowedCacheKey,
      value: T,
      ttl?: number,
    ) => Promise<T | undefined>;
  }) {
    this.cacheManager = cacheManager;
  }

  async check(ip: string): Promise<void> {
    const entry = await this.cacheManager.get<RateLimitEntry>(this.key(ip));
    if (!entry) return;

    if (entry.count >= RATE_LIMIT_MAX_FAILURES) {
      throw new ApiError(
        429,
        "Too many failed virtual API key attempts. Please try again later.",
      );
    }
  }

  async recordFailure(ip: string): Promise<void> {
    const entry = await this.cacheManager.get<RateLimitEntry>(this.key(ip));
    const newCount = (entry?.count ?? 0) + 1;
    await this.cacheManager.set<RateLimitEntry>(
      this.key(ip),
      { count: newCount },
      RATE_LIMIT_WINDOW_MS,
    );
  }

  private key(ip: string): AllowedCacheKey {
    return `${CacheKey.VirtualKeyRateLimit}-${ip}`;
  }
}

export const virtualKeyRateLimiter = new VirtualKeyRateLimiter(cacheManager);

async function validateClientCredentialsLlmOAuthAccessToken(params: {
  clientId: string;
  expectedProvider: string;
  agent: Agent;
}): Promise<LlmOAuthAccessTokenValidationResult> {
  const oauthClient = await LlmOauthClientModel.findByClientId(params.clientId);
  if (!oauthClient) {
    throw new ApiError(401, "LLM OAuth client is no longer available.");
  }
  if (oauthClient.disabled) {
    throw new ApiError(401, "LLM OAuth client is disabled.");
  }
  if (oauthClient.organizationId !== params.agent.organizationId) {
    throw new ApiError(403, "LLM OAuth client cannot access this LLM Proxy.");
  }
  if (!oauthClient.allowedLlmProxyIds.includes(params.agent.id)) {
    throw new ApiError(403, "LLM OAuth client cannot access this LLM Proxy.");
  }
  const mappedProviderKey = oauthClient.providerApiKeys.find(
    (mapping) => mapping.provider === params.expectedProvider,
  );
  if (!mappedProviderKey) {
    throw new ApiError(
      400,
      `LLM OAuth client is not mapped to provider "${params.expectedProvider}".`,
    );
  }

  const providerApiKey = await LlmProviderApiKeyModel.findById(
    mappedProviderKey.providerApiKeyId,
  );
  if (!providerApiKey) {
    throw new ApiError(
      500,
      "LLM OAuth client references a missing provider API key.",
    );
  }
  return resolveOAuthProviderApiKey({
    chatApiKeyId: providerApiKey.id,
    secretId: providerApiKey.secretId,
    baseUrl: providerApiKey.baseUrl,
    actualProvider: providerApiKey.provider,
    expectedProvider: params.expectedProvider,
    authMethod: "oauth_client_credentials",
    authenticatedApp: {
      id: oauthClient.id,
      name: oauthClient.name,
      clientId: oauthClient.clientId,
    },
  });
}

async function validateUserLlmOAuthAccessToken(params: {
  userId: string;
  clientId: string;
  expectedProvider: string;
  agent: Agent;
}): Promise<LlmOAuthAccessTokenValidationResult> {
  const member = await MemberModel.getFirstMembershipForUser(params.userId);
  if (!member || member.organizationId !== params.agent.organizationId) {
    throw new ApiError(401, "OAuth user is no longer available.");
  }

  const hasAgentAccess = await AgentTeamModel.userHasAgentAccess(
    params.userId,
    params.agent.id,
    false,
  );
  if (!hasAgentAccess) {
    throw new ApiError(403, "OAuth user cannot access this LLM Proxy.");
  }
  if (!isSupportedProvider(params.expectedProvider)) {
    throw new ApiError(
      400,
      `OAuth user access is not supported for provider "${params.expectedProvider}".`,
    );
  }

  const resolved = await resolveProviderApiKey({
    organizationId: member.organizationId,
    userId: params.userId,
    provider: params.expectedProvider,
  });
  const oauthClient = await OAuthClientModel.findByClientId(params.clientId);

  return {
    apiKey: resolved.apiKey,
    baseUrl: resolved.baseUrl ?? undefined,
    chatApiKeyId: resolved.chatApiKeyId,
    authMethod: "oauth_user",
    authenticatedApp: oauthClient
      ? {
          id: oauthClient.id,
          name: oauthClient.name ?? oauthClient.clientId,
          clientId: oauthClient.clientId,
        }
      : undefined,
    userId: params.userId,
  };
}

async function resolveOAuthProviderApiKey(params: {
  chatApiKeyId: string;
  secretId: string | null;
  baseUrl: string | null;
  actualProvider: string;
  expectedProvider: string;
  authMethod: "oauth_client_credentials" | "oauth_user";
  authenticatedApp?: {
    id: string;
    name: string;
    clientId: string;
  };
}): Promise<LlmOAuthAccessTokenValidationResult> {
  if (params.actualProvider !== params.expectedProvider) {
    throw new ApiError(
      400,
      `LLM OAuth client provider key is for provider "${params.actualProvider}", but request is for "${params.expectedProvider}"`,
    );
  }

  const apiKey = params.secretId
    ? await getSecretValueForLlmProviderApiKey(params.secretId)
    : undefined;
  return {
    apiKey,
    baseUrl: params.baseUrl ?? undefined,
    chatApiKeyId: params.chatApiKeyId,
    authMethod: params.authMethod,
    authenticatedApp: params.authenticatedApp,
  };
}

function hasLlmProxyScope(scopes: string[] | null | undefined): boolean {
  return scopes?.some((scope) => scope === LLM_PROXY_OAUTH_SCOPE) ?? false;
}

function isJwtLike(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  return parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}
