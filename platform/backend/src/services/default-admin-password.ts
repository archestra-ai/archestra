import { createHash } from "node:crypto";
import { verifyPassword } from "better-auth/crypto";
import { LRUCacheManager } from "@/cache-manager";

/**
 * Whether a stored password hash is the configured default admin password.
 *
 * The answer backs a banner every signed-in page asks about, and a password
 * hash verify is deliberately slow CPU work on the event loop. It is a pure
 * function of the hash and the password, so each pair is verified once per
 * process. A password change writes a new hash (a new salt every time), so
 * the old answer is simply never asked for again: no invalidation hook is
 * needed. Keys are digests, so the cache holds no hash or password.
 */
class DefaultAdminPasswordCheck {
  private readonly results = new LRUCacheManager<boolean>({
    maxSize: 16,
    // Never stale for its key; evicted only by size.
    defaultTtl: 0,
  });

  async matches(params: { password: string; hash: string }): Promise<boolean> {
    const key = createHash("sha256")
      .update(params.password)
      .update("\u0000")
      .update(params.hash)
      .digest("hex");
    const cached = this.results.get(key);
    if (cached !== undefined) return cached;
    const result = await verifyPassword(params);
    this.results.set(key, result);
    return result;
  }
}

export const defaultAdminPasswordCheck = new DefaultAdminPasswordCheck();
