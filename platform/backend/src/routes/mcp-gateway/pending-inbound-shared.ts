import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import type {
  ParkedClientMessage,
  PendingRequestRecord,
  SharedPendingRequests,
} from "./pending-inbound-requests";

/**
 * Pending in-band requests in the Postgres-backed cache that every replica
 * shares. Each wire id has its own lock, and the owner lease has its own key.
 * Claim, cancel, and take of one request serialize on that wire. Replicas and
 * organizations do not share a lock. A batch read finds candidates; only those
 * wires are locked, in wire-id order, one at a time.
 */
export const cachedPendingRequests: SharedPendingRequests = {
  async remember({ wireId, record, ttlMs }) {
    await cacheManager.withLock(recordKey(wireId), async (cache) => {
      await cache.set(recordKey(wireId), record, ttlMs);
    });
  },

  async renewOwner({ ownerId, expiresAt, ttlMs }) {
    await cacheManager.withLock(ownerKey(ownerId), async (cache) => {
      await cache.set(ownerKey(ownerId), { expiresAt }, ttlMs);
    });
  },

  async lookup(wireId) {
    const found = await cacheManager.readMany<PendingRequestRecord>([
      recordKey(wireId),
    ]);
    return found.get(recordKey(wireId));
  },

  async claim({ wireId, organizationId, agentId, caller, message }) {
    return cacheManager.withLock(recordKey(wireId), async (cache) => {
      const record = await cache.get<PendingRequestRecord>(recordKey(wireId));
      if (!record || record.status !== "waiting") return false;
      if (
        record.organizationId !== organizationId ||
        record.agentId !== agentId ||
        record.caller !== caller
      ) {
        logger.warn(
          { agentId },
          "Ignored an answer to a server-initiated request asked of another caller",
        );
        return false;
      }
      const now = Date.now();
      if (now >= record.deadlineAt) return false;
      const lease = await cache.get<OwnerLease>(ownerKey(record.ownerId));
      if (!lease || now >= lease.expiresAt) return false;
      const ttlMs = Math.max(1, record.deadlineAt - now);
      await cache.set(
        recordKey(wireId),
        { ...record, status: "queued" },
        ttlMs,
      );
      await cache.set(
        answerKey(wireId),
        { organizationId, agentId, caller, message },
        ttlMs,
      );
      return true;
    });
  },

  async take({ ownerId, wireIds }) {
    if (wireIds.length === 0) return [];
    const now = Date.now();
    if (!(await ownerLeaseLive(ownerId, now))) return [];
    const answers = await cacheManager.readMany<ParkedClientMessage>(
      wireIds.map(answerKey),
    );
    const taken: Array<{ wireId: string; parked: ParkedClientMessage }> = [];
    for (const wireId of [...wireIds].sort()) {
      if (!answers.has(answerKey(wireId))) continue;
      const parked = await cacheManager.withLock(
        recordKey(wireId),
        async (cache) => {
          if (!(await ownerLeaseLive(ownerId, Date.now(), cache))) {
            return undefined;
          }
          const record = await cache.get<PendingRequestRecord>(
            recordKey(wireId),
          );
          const message = await cache.get<ParkedClientMessage>(
            answerKey(wireId),
          );
          if (
            !record ||
            !message ||
            record.status !== "queued" ||
            record.ownerId !== ownerId ||
            Date.now() >= record.deadlineAt ||
            record.organizationId !== message.organizationId ||
            record.agentId !== message.agentId ||
            record.caller !== message.caller
          ) {
            return undefined;
          }
          const ttlMs = Math.max(1, record.deadlineAt - Date.now());
          await cache.set(
            recordKey(wireId),
            { ...record, status: "answered" },
            ttlMs,
          );
          await cache.delete(answerKey(wireId));
          return message;
        },
      );
      if (parked) taken.push({ wireId, parked });
    }
    return taken;
  },

  async forget(wireId) {
    await cacheManager.withLock(recordKey(wireId), async (cache) => {
      const record = await cache.get<PendingRequestRecord>(recordKey(wireId));
      if (record) {
        await cache.set(
          recordKey(wireId),
          { ...record, status: "cancelled" },
          Math.max(1, record.deadlineAt - Date.now()),
        );
      }
      await cache.delete(answerKey(wireId));
    });
  },
};

type OwnerLease = { expiresAt: number };

async function ownerLeaseLive(
  ownerId: string,
  now: number,
  cache?: {
    get: <T>(key: AllowedCacheKey) => Promise<T | undefined>;
  },
): Promise<boolean> {
  const key = ownerKey(ownerId);
  const lease = cache
    ? await cache.get<OwnerLease>(key)
    : (await cacheManager.readMany<OwnerLease>([key])).get(key);
  return lease !== undefined && now < lease.expiresAt;
}

function recordKey(wireId: string): AllowedCacheKey {
  return `${CacheKey.McpGatewayPendingRequest}-${wireId}`;
}

function ownerKey(ownerId: string): AllowedCacheKey {
  return `${CacheKey.McpGatewayPendingRequest}-owner-${ownerId}`;
}

function answerKey(wireId: string): AllowedCacheKey {
  return `${CacheKey.McpGatewayParkedAnswer}-${wireId}`;
}
