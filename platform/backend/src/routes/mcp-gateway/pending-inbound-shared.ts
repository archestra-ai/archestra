import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import type {
  ParkedClientMessage,
  PendingRequestRecord,
  SharedPendingRequests,
} from "./pending-inbound-requests";

/**
 * Pending in-band requests in the Postgres-backed cache that every replica
 * shares, so an answer the load balancer sends to another replica still
 * reaches the one waiting for it.
 */
export const cachedPendingRequests: SharedPendingRequests = {
  async remember({ wireId, record, ttlMs }) {
    await cacheManager.set(recordKey(wireId), record, ttlMs);
  },

  async lookup(wireId) {
    return cacheManager.get<PendingRequestRecord>(recordKey(wireId));
  },

  async park({ wireId, parked, ttlMs }) {
    await cacheManager.set(answerKey(wireId), parked, ttlMs);
  },

  async take(wireIds) {
    const entries = await cacheManager.getAndDeleteMany<ParkedClientMessage>(
      wireIds.map(answerKey),
    );
    return entries.map(({ key, value }) => ({
      wireId: key.slice(`${CacheKey.McpGatewayParkedAnswer}-`.length),
      parked: value,
    }));
  },

  async forget(wireId) {
    await Promise.all([
      cacheManager.delete(recordKey(wireId)),
      cacheManager.delete(answerKey(wireId)),
    ]);
  },
};

function recordKey(wireId: string): AllowedCacheKey {
  return `${CacheKey.McpGatewayPendingRequest}-${wireId}`;
}

function answerKey(wireId: string): AllowedCacheKey {
  return `${CacheKey.McpGatewayParkedAnswer}-${wireId}`;
}
