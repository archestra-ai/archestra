import { CacheKey } from "@/cache-manager";
import { RouteRateLimiter } from "@/services/route-rate-limit";

/**
 * One budget per trusted client IP, shared by every grant and web replica.
 */
export const oauthTokenRateLimiter = new RouteRateLimiter({
  scope: CacheKey.OAuthTokenRateLimit,
  windowMs: 60_000,
  maxRequests: 100,
});
