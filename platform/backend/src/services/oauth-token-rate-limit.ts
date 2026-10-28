import { CacheKey, type CacheKeyPrefix, cacheManager } from "@/cache-manager";

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 100;

class TokenEndpointRateLimiter {
  constructor(private readonly prefix: CacheKeyPrefix) {}

  /** One budget per trusted client IP, shared by every web replica. */
  async consume(ip: string): Promise<{ allowed: boolean; retryAfter: number }> {
    const key = `${this.prefix}-${ip}` as const;
    return cacheManager.withLock(key, async (cache) => {
      const now = Date.now();
      const existing = await cache.get<{ count: number; windowEndsAt: number }>(
        key,
      );
      const window =
        existing && existing.windowEndsAt > now
          ? existing
          : { count: 0, windowEndsAt: now + WINDOW_MS };
      const retryAfter = Math.max(
        1,
        Math.ceil((window.windowEndsAt - now) / 1000),
      );
      if (window.count >= MAX_REQUESTS) return { allowed: false, retryAfter };
      await cache.set(
        key,
        { count: window.count + 1, windowEndsAt: window.windowEndsAt },
        window.windowEndsAt - now,
      );
      return { allowed: true, retryAfter };
    });
  }
}

/** The OAuth token endpoint, shared by every grant. */
export const oauthTokenRateLimiter = new TokenEndpointRateLimiter(
  CacheKey.OAuthTokenRateLimit,
);

/** The GitHub Actions token exchange, a budget of its own. */
export const githubActionsTokenRateLimiter = new TokenEndpointRateLimiter(
  CacheKey.GitHubActionsTokenRateLimit,
);
