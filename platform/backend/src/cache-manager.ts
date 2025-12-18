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
    return await this.cache.set(key, value, ttl);
  }

  async delete(key: AllowedCacheKey): Promise<boolean> {
    return await this.cache.del(key);
  }

  async wrap<T>(
    key: AllowedCacheKey,
    fnc: () => Promise<T>,
    { ttl, refreshThreshold }: { ttl?: number; refreshThreshold?: number } = {},
  ): Promise<T> {
    return await this.cache.wrap(key, fnc, { ttl, refreshThreshold });
  }
}

export const CacheKey = {
  GetChatModels: "get-chat-models",
} as const;
export type CacheKey = (typeof CacheKey)[keyof typeof CacheKey];

type AllowedCacheKey = `${CacheKey}` | `${CacheKey}-${string}`;

export const cacheManager = new CacheManager();
