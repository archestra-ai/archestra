import { TimeInMs } from "@shared";
import { createCache } from "cache-manager";

class CacheManager {
  private cache: ReturnType<typeof createCache>;

  constructor() {
    this.cache = createCache({
      ttl: TimeInMs.Hour,
    });
  }

  async get<T>(key: AllowedCacheKey): Promise<T | undefined> {
    return this.cache.get<T>(key);
  }

  async set<T>(
    key: AllowedCacheKey,
    value: T,
    ttl?: number,
  ): Promise<T | undefined> {
    return this.cache.set(key, value, ttl);
  }

  async delete(key: AllowedCacheKey): Promise<boolean> {
    return this.cache.del(key);
  }

  /**
   * Delete all cache entries that start with the given prefix.
   * This is useful for invalidating all related cache entries at once.
   */
  async deleteByPrefix(prefix: AllowedCacheKey): Promise<void> {
    // https://www.npmjs.com/package/cache-manager#doing-iteration-on-stores
    const store = this.cache.stores[0];

    if (store?.iterator) {
      for await (const [key] of store.iterator({})) {
        if (key.startsWith(prefix)) {
          await this.cache.del(key);
        }
      }
    }
  }

  async wrap<T>(
    key: AllowedCacheKey,
    fnc: () => Promise<T>,
    { ttl, refreshThreshold }: { ttl?: number; refreshThreshold?: number } = {},
  ): Promise<T> {
    return this.cache.wrap(key, fnc, { ttl, refreshThreshold });
  }
}

export const CacheKey = {
  GetChatModels: "get-chat-models",
  ChatMcpTools: "chat-mcp-tools",
  ProcessedEmail: "processed-email",
  WebhookRateLimit: "webhook-rate-limit",
  OAuthState: "oauth-state",
  McpSession: "mcp-session",
  SsoGroups: "sso-groups",
} as const;
export type CacheKey = (typeof CacheKey)[keyof typeof CacheKey];

type AllowedCacheKey = `${CacheKey}` | `${CacheKey}-${string}`;

export const cacheManager = new CacheManager();
