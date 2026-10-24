import { LRUCacheManager } from "@/cache-manager";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { PgNotifyHub } from "@/services/pg-notify-hub";
import { sharedNotifyHub } from "@/services/shared-notify-hub";

/**
 * Channel the database notifies when a row the proxy's per-request reads
 * depend on changes. Triggers on those tables publish it (see the
 * `archestra_notify_proxy_config` migration), so every write path is covered
 * however it reaches the database.
 */
export const PROXY_CONFIG_CHANNEL = "archestra_proxy_config";

/**
 * Upper bound on how long an entry may outlive a change whose notification was
 * lost, for example while the listener's connection is dying but not yet
 * closed. Delivered notifications drop entries within milliseconds.
 */
export const PROXY_CONFIG_TTL_MS = 5_000;

/**
 * Per-process cache for the configuration rows every proxied request reads:
 * the gateway, the credential and its owner's membership, and the request's
 * policy and budget rules.
 *
 * Entries are used only while database notifications are proven to arrive,
 * and only within one listener session. Any change notification drops every
 * entry. Without delivery (a transaction pooler, polling compatibility, or a
 * reconnecting listener) each read goes to the database as before. Cached
 * values are shared between requests and must not be mutated.
 */
export class ProxyConfigCache {
  private readonly entries = registerProcessLocalCache(
    new LRUCacheManager<{ stamp: string; value: unknown }>({
      maxSize: 10_000,
      defaultTtl: PROXY_CONFIG_TTL_MS,
    }),
  );
  private invalidations = 0;
  /** Null until subscribed; entries are trusted only after this time. */
  private trustedAfter: number | null = null;

  constructor(private readonly hub: PgNotifyHub) {}

  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const stamp = this.stamp();
    if (stamp === null) return load();
    const hit = this.entries.get(key);
    if (hit?.stamp === stamp) return hit.value as T;
    const value = await load();
    // A change that landed while this read ran may not be reflected in it.
    if (this.stamp() === stamp) this.entries.set(key, { stamp, value });
    return value;
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private stamp(): string | null {
    if (this.trustedAfter === null) {
      // On a listener that is already connected, LISTEN for this channel is
      // issued after subscribing. Later sessions LISTEN before they verify.
      this.trustedAfter = Date.now() + LISTEN_SETTLE_MS;
      this.hub.fanout(PROXY_CONFIG_CHANNEL).subscribe(() => {
        this.invalidations++;
        this.entries.clear();
      });
    }
    const generation = this.hub.deliveryGeneration();
    if (generation === null || Date.now() < this.trustedAfter) return null;
    return `${generation}:${this.invalidations}`;
  }
}

export const proxyConfigCache = new ProxyConfigCache(sharedNotifyHub);

const LISTEN_SETTLE_MS = 2_000;
