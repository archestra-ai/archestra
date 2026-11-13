import { type AllowedCacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";

/** How often a caller that waits looks again whether a lease has ended. */
const LEASE_POLL_MS = 1000;

/**
 * Run `work` while holding a lease that every replica sees, so two callers do
 * not open the same pull request at once. A lease ends when `work` settles,
 * or after `ttlMs` when its holder died. Another caller that finds it held
 * runs nothing: at once, or once `waitMs` has passed with the lease still
 * held. `ran: false` says so, apart from what `work` itself returned.
 */
export async function withOpenAppaLease<T>(params: {
  key: AllowedCacheKey;
  ttlMs: number;
  /** How long to wait for a lease another caller holds; none by default. */
  waitMs?: number;
  work: () => Promise<T>;
}): Promise<{ ran: true; value: T } | { ran: false }> {
  const { key } = params;
  const deadline = Date.now() + (params.waitMs ?? 0);
  for (;;) {
    const claimed = await cacheManager.withLock(key, async (cache) => {
      if (await cache.get(key)) return false;
      await cache.set(key, true, params.ttlMs);
      return true;
    });
    if (claimed) break;
    if (Date.now() + LEASE_POLL_MS > deadline) return { ran: false };
    await new Promise((resolve) => setTimeout(resolve, LEASE_POLL_MS));
  }
  try {
    return { ran: true, value: await params.work() };
  } finally {
    await cacheManager
      .withLock(key, (cache) => cache.delete(key))
      .catch((error) =>
        logger.warn(
          { key, error },
          "OpenAPPA could not end a lease; it ends on its own",
        ),
      );
  }
}
