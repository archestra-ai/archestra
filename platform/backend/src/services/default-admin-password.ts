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
 * needed. Entries are keyed by the stored hash and keep the password they
 * were checked against, which is the configured default the process holds
 * anyway; nothing is hashed here, so no weak hash of a password exists.
 */
class DefaultAdminPasswordCheck {
  private readonly results = new LRUCacheManager<{
    password: string;
    matches: boolean;
  }>({
    maxSize: 16,
    // Never stale for its key; evicted only by size.
    defaultTtl: 0,
  });

  async matches(params: { password: string; hash: string }): Promise<boolean> {
    const cached = this.results.get(params.hash);
    if (cached !== undefined && cached.password === params.password) {
      return cached.matches;
    }
    const matches = await verifyPassword(params);
    this.results.set(params.hash, { password: params.password, matches });
    return matches;
  }
}

export const defaultAdminPasswordCheck = new DefaultAdminPasswordCheck();
