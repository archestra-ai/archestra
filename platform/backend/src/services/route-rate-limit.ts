import type { FastifyReply, FastifyRequest } from "fastify";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { ApiError } from "@/types";
import { isLoopbackRequest } from "@/utils/network";

/**
 * Shared per-identity request budget, one fixed window per identity.
 *
 * Counts run inside a CacheManager lock, so the budget holds across concurrent
 * requests and across every web replica. Storage failures surface as thrown
 * errors so callers can fail closed.
 */
export class RouteRateLimiter {
  private readonly scope: AllowedCacheKey;
  private readonly windowMs: number;
  private readonly maxRequests: number;

  constructor(params: {
    scope: AllowedCacheKey;
    windowMs: number;
    maxRequests: number;
  }) {
    this.scope = params.scope;
    this.windowMs = params.windowMs;
    this.maxRequests = params.maxRequests;
  }

  async consume(identity: string): Promise<RateLimitDecision> {
    const key = `${this.scope}-${identity}` as AllowedCacheKey;
    const { windowMs, maxRequests } = this;
    return cacheManager.withLock(key, async (cache) => {
      const now = Date.now();
      const existing = await cache.get<{ count: number; windowEndsAt: number }>(
        key,
      );
      const window =
        existing && existing.windowEndsAt > now
          ? existing
          : { count: 0, windowEndsAt: now + windowMs };
      const retryAfter = Math.max(
        1,
        Math.ceil((window.windowEndsAt - now) / 1000),
      );
      if (window.count >= maxRequests) return { allowed: false, retryAfter };
      await cache.set(
        key,
        { count: window.count + 1, windowEndsAt: window.windowEndsAt },
        window.windowEndsAt - now,
      );
      return { allowed: true, retryAfter };
    });
  }
}

/**
 * Route-level guard keyed by the trusted client IP (`request.ip`, which follows
 * Fastify's trustProxy policy). Rejects with 429 and `Retry-After`, or 503 when
 * the shared rate-limit storage is unavailable.
 *
 * - `appliesTo` limits the hook to a subset of requests on a shared route.
 * - `exemptLoopback` skips in-cluster callers (in-app chat); the socket peer
 *   cannot be forged, so this does not widen the public surface.
 * - `enabled` lets an operator switch the guard off through config.
 */
export function createIpRateLimitHook(params: {
  limiter: RouteRateLimiter;
  message: string;
  appliesTo?: (request: FastifyRequest) => boolean;
  exemptLoopback?: boolean;
  enabled?: () => boolean;
}) {
  return async function enforceIpRateLimit(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (params.enabled && !params.enabled()) return;
    if (params.appliesTo && !params.appliesTo(request)) return;
    if (params.exemptLoopback && isLoopbackRequest(request)) return;

    let decision: RateLimitDecision;
    try {
      decision = await params.limiter.consume(request.ip);
    } catch (error) {
      logger.error({ err: error }, "Route rate-limit storage unavailable");
      throw new ApiError(
        503,
        "Rate limiting is temporarily unavailable. Retry later.",
      );
    }
    if (decision.allowed) return;
    reply.header("Retry-After", decision.retryAfter);
    throw new ApiError(429, params.message);
  };
}

/** Auth routes: OAuth flows, DCR, member removal, SSO start. */
export const authRouteRateLimiter = new RouteRateLimiter({
  scope: CacheKey.AuthRouteRateLimit,
  windowMs: 60_000,
  maxRequests: 120,
});

/** Credential-verifying auth routes: sign-in, sign-up, password reset, 2FA, verification. */
export const authCredentialRateLimiter = new RouteRateLimiter({
  scope: CacheKey.AuthCredentialRateLimit,
  windowMs: 60_000,
  maxRequests: 60,
});

/** LLM proxy model listing: each call makes an upstream provider request. */
export const llmModelsListRateLimiter = new RouteRateLimiter({
  scope: CacheKey.LlmModelsListRateLimit,
  windowMs: 60_000,
  maxRequests: 120,
});

/** MCP Gateway POST requests. */
export const mcpGatewayRateLimiter = new RouteRateLimiter({
  scope: CacheKey.McpGatewayRateLimit,
  windowMs: 60_000,
  maxRequests: 600,
});

/**
 * In-app chat reaches these routes over loopback, where every user shares one
 * IP, so loopback callers are exempt (see `isLoopbackRequest`).
 */
export const enforceLlmModelsListRateLimit = createIpRateLimitHook({
  limiter: llmModelsListRateLimiter,
  message: "Too many model list requests. Retry after the indicated delay.",
  exemptLoopback: true,
});

export const enforceMcpGatewayRateLimit = createIpRateLimitHook({
  limiter: mcpGatewayRateLimiter,
  message: "Too many MCP Gateway requests. Retry after the indicated delay.",
  exemptLoopback: true,
});

// =============================================================================
// Internal helpers
// =============================================================================

type RateLimitDecision = { allowed: boolean; retryAfter: number };
