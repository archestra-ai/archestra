/**
 * Authentication and API key resolution for the LLM proxy handler.
 *
 * Extracted from handleLLMProxy to keep the main handler focused on
 * request/response orchestration. Each function is independently testable.
 */

import { ARCHESTRA_TOKEN_PREFIX } from "@shared";
import type { FastifyRequest } from "fastify";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import { resolveProviderApiKey } from "@/clients/llm-client";
import logger from "@/logging";
import { AgentModel, VirtualApiKeyModel } from "@/models";
import { validateExternalIdpToken } from "@/routes/mcp-gateway.utils";
import { getSecretValueForLlmProviderApiKey } from "@/secrets-manager";
import { type Agent, ApiError, isSupportedChatProvider } from "@/types";
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
}

/**
 * Validate an `archestra_` prefixed virtual API key.
 * Checks: token validity, expiration, provider match, parent key health.
 * Returns the resolved real API key and optional base URL.
 *
 * Throws ApiError on validation failure.
 */
export async function validateVirtualApiKey(
  tokenValue: string,
  expectedProvider: string,
): Promise<VirtualKeyValidationResult> {
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

  if (resolved.chatApiKey.provider !== expectedProvider) {
    throw new ApiError(
      400,
      `Virtual API key is for provider "${resolved.chatApiKey.provider}", but request is for "${expectedProvider}"`,
    );
  }

  // Resolve the real provider API key from the secret.
  // If the parent key's secret was removed (orphaned row), apiKey will be
  // undefined. For providers that require keys, the upstream call will fail
  // with a clear error. For keyless providers the virtual key alone is
  // sufficient authentication.
  let apiKey: string | undefined;
  if (resolved.chatApiKey.secretId) {
    const secretValue = await getSecretValueForLlmProviderApiKey(
      resolved.chatApiKey.secretId,
    );
    if (secretValue) {
      apiKey = secretValue as string;
    } else {
      logger.warn(
        {
          virtualKeyId: resolved.virtualKey.id,
          chatApiKeyId: resolved.chatApiKey.id,
          secretId: resolved.chatApiKey.secretId,
        },
        "Virtual key's parent chat API key secret could not be resolved (may be orphaned)",
      );
    }
  }

  return {
    apiKey,
    baseUrl: resolved.chatApiKey.baseUrl ?? undefined,
  };
}

// =========================================================================
// JWKS Authentication
// =========================================================================

export interface JwksAuthResult {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  userId: string | undefined;
  organizationId: string;
}

/**
 * Attempt JWKS authentication for agents with an external identity provider.
 * Returns null if no JWKS auth was attempted (no IdP configured, no bearer token, or virtual key token).
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
  if (!bearerToken || bearerToken.startsWith(ARCHESTRA_TOKEN_PREFIX))
    return null;

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

  if (isSupportedChatProvider(providerName)) {
    const resolved = await resolveProviderApiKey({
      organizationId: jwksResult.organizationId,
      userId: jwksResult.userId,
      provider: providerName,
    });
    apiKey = resolved.apiKey;
    baseUrl = resolved.baseUrl ?? undefined;
  }

  return {
    apiKey,
    baseUrl,
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
      "Authentication required. Use a virtual API key (archestra_...) or pass a provider API key.",
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
