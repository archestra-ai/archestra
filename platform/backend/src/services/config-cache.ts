import { requestScope } from "@/auth/request-scope";
import { LRUCacheManager } from "@/cache-manager";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";
import type { PgNotifyHub } from "@/services/pg-notify-hub";
import { sharedNotifyHub } from "@/services/shared-notify-hub";

/**
 * Channel the database notifies when a row the proxy's per-request reads
 * depend on changes. Triggers on those tables publish it (see the
 * `archestra_notify_proxy_config` migration), so every write path is covered
 * however it reaches the database.
 * @public — exported for testability
 */
export const PROXY_CONFIG_CHANNEL = "archestra_proxy_config";

/**
 * Upper bound on how long an entry may outlive a change whose notification was
 * lost, for example while the listener's connection is dying but not yet
 * closed. Delivered notifications drop entries within milliseconds.
 * @public — exported for testability
 */
export const PROXY_CONFIG_TTL_MS = 5_000;

/**
 * Per-process cache for the configuration rows every proxied request reads:
 * the gateway, the credential and its owner's membership, the request's
 * policy and budget rules, and which of its declared tools are already known.
 * MCP gateway calls that opt in read their configuration through `readConfig`.
 *
 * Entries are used only while database notifications are proven to arrive,
 * and only within one listener session. Any change notification drops every
 * entry. Without delivery (a transaction pooler, polling compatibility, or a
 * reconnecting listener) each read goes to the database as before. Cached
 * values are shared between requests and must not be mutated.
 *
 * Under load an entry is refreshed in the background before it expires, and
 * concurrent misses share one read, so expiry never stalls a burst of requests.
 * @public — exported for testability (one instance per simulated replica)
 */
export class ConfigCache {
  private readonly entries = registerProcessLocalCache(
    new LRUCacheManager<Entry>({
      maxSize: 10_000,
      defaultTtl: PROXY_CONFIG_TTL_MS,
    }),
  );
  private readonly loading = registerProcessLocalCache(
    new Map<string, { stamp: string; value: Promise<unknown> }>(),
  );
  private invalidations = 0;
  /** Null until subscribed; entries are trusted only after this time. */
  private trustedAfter: number | null = null;

  constructor(private readonly hub: PgNotifyHub) {}

  /**
   * Configuration a request reads repeatedly, read once per request. A request
   * that opted in with `requestScope.enter({ sharesConfig: true })` reads it
   * through {@link read} instead, sharing it with other requests. Each request
   * gets its own copy, so a caller may change what it receives; the value
   * must be cloneable.
   */
  readShared<T>(key: string, load: () => Promise<T>): Promise<T> {
    return requestScope.memo<T>(`config:${key}`, () =>
      requestScope.sharesConfig()
        ? this.read<T>(`shared:${key}`, load).then((value) =>
            structuredClone(value),
          )
        : load(),
    );
  }

  async read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const stamp = this.stamp();
    if (stamp === null) return load();
    const hit = this.entries.get(key);
    if (hit?.stamp !== stamp) return this.load(key, stamp, load);
    if (Date.now() - hit.readAt > REFRESH_AFTER_MS) {
      this.load(key, stamp, load).catch((error) =>
        logger.debug({ error }, "Proxy configuration refresh failed"),
      );
    }
    return hit.value as T;
  }

  // ===========================================================================
  // Internal
  // ===========================================================================

  private load<T>(
    key: string,
    stamp: string,
    load: () => Promise<T>,
  ): Promise<T> {
    const pending = this.loading.get(key);
    if (pending?.stamp === stamp) return pending.value as Promise<T>;
    const readAt = Date.now();
    const value = load()
      .then((loaded) => {
        // A change that landed while this read ran may not be reflected in it.
        // The entry's age counts from when the database was read.
        const ttl = PROXY_CONFIG_TTL_MS - (Date.now() - readAt);
        if (this.stamp() === stamp && ttl > 0)
          this.entries.set(key, { stamp, readAt, value: loaded }, ttl);
        return loaded;
      })
      .finally(() => {
        if (this.loading.get(key)?.value === value) this.loading.delete(key);
      });
    this.loading.set(key, { stamp, value });
    return value;
  }

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

export const configCache = new ConfigCache(sharedNotifyHub);

/** {@link ConfigCache.readShared} on the process-wide cache. */
export function readConfig<T>(key: string, load: () => Promise<T>): Promise<T> {
  return configCache.readShared(key, load);
}

type Entry = { stamp: string; readAt: number; value: unknown };

const LISTEN_SETTLE_MS = 2_000;
/** Refresh in the background once an entry is this old, before it expires. */
const REFRESH_AFTER_MS = PROXY_CONFIG_TTL_MS - 1_000;
