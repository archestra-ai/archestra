import { LRUCacheManager } from "@/in-memory-lru-cache";
import { UserModel } from "@/models";

/**
 * Whether the identity provider deactivated a user through SCIM
 * (`user.soft_deleted`), for the request paths that authenticate a user by a
 * token on every call: the MCP gateway, the LLM proxy and the app connector.
 *
 * The answer is cached for 30 seconds so those hot paths do not
 * query the database on every request. A change made through SCIM invalidates
 * the cache on the replica that made it; other replicas see it when their entry
 * expires. Sign-in reads the database directly, so it is never stale.
 */
class SoftDeletedUsers {
  private cache = new LRUCacheManager<boolean>({
    maxSize: 10_000,
    defaultTtl: 30_000,
  });

  async isSoftDeleted(userId: string): Promise<boolean> {
    const cached = this.cache.get(userId);
    if (cached !== undefined) return cached;
    const softDeleted = (await UserModel.getSoftDeleted(userId)) !== null;
    this.cache.set(userId, softDeleted);
    return softDeleted;
  }

  /** Forget the cached answer after the user's `soft_deleted` changed. */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }
}

export const softDeletedUsers = new SoftDeletedUsers();
