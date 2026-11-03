import { createHmac, randomBytes } from "node:crypto";
import {
  RateLimiterCompatibleAbstract,
  RateLimiterRes,
} from "rate-limiter-flexible";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import config from "@/config";
import logger from "@/logging";
import { registerProcessLocalCache } from "@/process-local-cache-registry";

const WINDOW_MS = 60_000;
const MAX_PER_CREDENTIAL = 10;
const MAX_TRACKED_CREDENTIALS_PER_IP = 100;
const MAX_AUTHENTICATION_OPERATIONS = 16;
let authenticationOperations = 0;

export class McpGatewayAuthenticationBusyError extends Error {}

/** A process-wide bound, including requests handled by different gateway plugins. */
export async function withMcpGatewayAuthenticationCapacity<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (authenticationOperations >= MAX_AUTHENTICATION_OPERATIONS) {
    throw new McpGatewayAuthenticationBusyError(
      "Gateway authentication capacity is exhausted",
    );
  }
  authenticationOperations += 1;
  try {
    return await operation();
  } finally {
    authenticationOperations -= 1;
  }
}
const FINGERPRINT_KEY = config.auth.secret || randomBytes(32);

type Caller = { credential?: string; gateway: string };
type Window = { count: number; endsAt: number };

/**
 * Reserve a shared attempt before gateway lookup/authentication. Successful
 * credential/gateway pairs are exempt for one minute, but still authenticate
 * on EVERY request; the exemption is discarded on any 401/403 response.
 *
 * Each IP retains at most 100 recent credential/gateway counters. There is no
 * shared IP allowance: unrelated guesses must not lock out new or idle clients.
 * Rotating guesses can evade a credential budget, so admission storage and
 * authentication also share a bounded process-wide work pool. IP locks keep
 * credential admission atomic across replicas without unbounded bucket rows.
 */
export class McpGatewayRateLimiter extends RateLimiterCompatibleAbstract {
  private readonly validated = registerProcessLocalCache(
    new LRUCacheManager<true>({ maxSize: 10_000, defaultTtl: WINDOW_MS }),
  );

  private readonly denied = registerProcessLocalCache(
    new LRUCacheManager<true>({ maxSize: 10_000, defaultTtl: WINDOW_MS }),
  );
  private readonly successWrites = registerProcessLocalCache(
    new LRUCacheManager<Promise<void>>({ maxSize: 10_000, defaultTtl: 1_000 }),
  );

  override async consume(
    key: string | number,
    points = 1,
    options?: Record<string, unknown>,
  ): Promise<RateLimiterRes> {
    return withMcpGatewayAuthenticationCapacity(() =>
      this.consumeWithinCapacity(key, points, options),
    );
  }

  private async consumeWithinCapacity(
    key: string | number,
    points: number,
    options?: Record<string, unknown>,
  ): Promise<RateLimiterRes> {
    if (
      typeof key !== "string" ||
      points !== 1 ||
      typeof options?.gateway !== "string" ||
      (options.credential !== undefined &&
        typeof options.credential !== "string")
    ) {
      throw new Error("Gateway rate limiting requires an IP and caller");
    }
    const caller: Caller = {
      gateway: options.gateway,
      credential: options.credential as string | undefined,
    };
    const verifiedKey = this.verifiedKey(caller);
    if (verifiedKey && !this.denied.has(verifiedKey)) {
      if (this.validated.has(verifiedKey)) return this.exempt();
      const entries = await cacheManager.readMany<true>([verifiedKey]);
      if (entries.get(verifiedKey)) {
        this.validated.set(verifiedKey, true);
        return this.exempt();
      }
    }
    const ipKey: AllowedCacheKey = `${CacheKey.McpGatewayRateLimit}-credentials-${key}`;
    const pair = this.fingerprint(
      JSON.stringify([caller.gateway, caller.credential]),
    );
    return cacheManager.withLock(ipKey, async (cache) => {
      const now = Date.now();
      const stored = await cache.get<Record<string, Window>>(ipKey);
      const windows = Object.fromEntries(
        Object.entries(stored ?? {}).filter(
          ([, window]) => window.endsAt > now,
        ),
      );
      const window = windows[pair] ?? { count: 0, endsAt: now + WINDOW_MS };
      if (window.count >= MAX_PER_CREDENTIAL) throw this.exhausted(window, now);
      if (
        !windows[pair] &&
        Object.keys(windows).length >= MAX_TRACKED_CREDENTIALS_PER_IP
      ) {
        // Bound attacker-controlled storage. Evict the oldest tracked credential,
        // never reject a different credential because this IP has been noisy.
        delete windows[Object.keys(windows)[0]];
      }
      windows[pair] = { ...window, count: window.count + 1 };
      await cache.set(ipKey, windows, WINDOW_MS);
      return new RateLimiterRes(
        MAX_PER_CREDENTIAL - window.count - 1,
        window.endsAt - now,
        window.count + 1,
        window.count === 0,
      );
    });
  }

  async recordSuccess(caller: Caller): Promise<void> {
    const key = this.verifiedKey(caller);
    if (!key) return;
    this.denied.delete(key);
    this.validated.set(key, true);
    // Successful traffic renews the lease; coalesce shared writes to at most
    // once per second per process without caching the authorization itself.
    const pending = this.successWrites.get(key);
    if (pending) return pending;
    const write = this.writeSuccess(key);
    this.successWrites.set(key, write);
    await write;
  }

  private async writeSuccess(key: AllowedCacheKey): Promise<void> {
    try {
      await cacheManager.set(key, true, WINDOW_MS);
    } catch (error) {
      this.successWrites.delete(key);
      // Losing an exemption affects availability, not authorization. This
      // process just authenticated the caller and can retain its local mark.
      logger.debug(
        { err: error },
        "Could not renew gateway rate-limit exemption",
      );
    }
  }

  async recordDenial(caller: Caller): Promise<void> {
    const key = this.verifiedKey(caller);
    if (!key) return;
    this.validated.delete(key);
    this.successWrites.delete(key);
    // Do not reload a stale shared positive if deletion fails. Other replicas
    // still authorize every request and discard their mark on their first denial.
    this.denied.set(key, true);
    try {
      await cacheManager.delete(key, { throwOnError: true });
    } catch (error) {
      logger.warn(
        { err: error },
        "Could not remove gateway rate-limit exemption",
      );
    }
  }

  private verifiedKey(caller: Caller): AllowedCacheKey | null {
    return caller.credential
      ? `${CacheKey.McpGatewayRateLimit}-ok-${this.fingerprint(JSON.stringify([caller.gateway, caller.credential]))}`
      : null;
  }

  private fingerprint(value: string): string {
    return createHmac("sha256", FINGERPRINT_KEY)
      .update("mcp-gateway-rate-limit\0")
      .update(value)
      .digest("base64url");
  }

  private exhausted(window: Window, now: number): RateLimiterRes {
    return new RateLimiterRes(0, window.endsAt - now, window.count, false);
  }

  private exempt(): RateLimiterRes {
    return new RateLimiterRes(MAX_PER_CREDENTIAL, 0, 0, false);
  }
}
