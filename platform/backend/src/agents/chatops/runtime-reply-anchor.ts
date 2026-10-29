import { createHash, randomUUID } from "node:crypto";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";
import { trackBackgroundWork } from "@/utils/background-work";

export async function startRuntimeAcknowledgement(params: {
  taskId: string;
  send: () => Promise<void>;
}): Promise<{ delivery: Promise<void> }> {
  const key: AllowedCacheKey = `${CacheKey.ChatOpsRuntimeAcknowledgement}-${params.taskId}`;
  const token = randomUUID();
  // Register before launch; completion delivery on another replica must also wait.
  await cacheManager.set(key, token, 60_000);
  const delivery = Promise.resolve()
    .then(params.send)
    .finally(async () => {
      await cacheManager.withLock(key, async (cache) => {
        if ((await cache.get<string>(key)) === token) await cache.delete(key);
      });
    })
    .catch((error) => {
      logger.warn(
        { error, taskId: params.taskId },
        "Could not acknowledge the Agent Runtime session",
      );
    });
  trackBackgroundWork(delivery);
  return { delivery };
}

export async function assertRuntimeAcknowledgementSettled(
  taskId: string,
): Promise<void> {
  if (
    await cacheManager.get(
      `${CacheKey.ChatOpsRuntimeAcknowledgement}-${taskId}`,
      { throwOnError: true },
    )
  ) {
    throw new Error("The runtime acknowledgment is still being delivered");
  }
}

export async function sendRuntimeReplyWithAnchor(params: {
  organizationId: string;
  bindingId: string;
  threadId: string;
  providerScope?: string;
  /** A linked acknowledgment can stand alone while another reply owns the footer. */
  anchorOptional?: boolean;
  send: (includeAnchor: boolean) => Promise<string>;
}): Promise<void> {
  const scope = createHash("sha256")
    .update(
      JSON.stringify([
        params.organizationId,
        params.bindingId,
        params.threadId,
        params.providerScope ?? null,
      ]),
    )
    .digest("hex");
  const key: AllowedCacheKey = `${CacheKey.ChatOpsReplyAnchor}-${scope}`;
  const leaseKey: AllowedCacheKey = `${key}-lease`;
  const token = randomUUID();
  const includeAnchor = await cacheManager.withLock(key, async (cache) => {
    if (await cache.get<boolean>(key)) return false;
    if (await cache.get<string>(leaseKey)) {
      if (params.anchorOptional) return false;
      throw new Error("The first conversation reply is still being delivered");
    }
    await cache.set(leaseKey, token, 5 * 60_000);
    return true;
  });

  if (!includeAnchor) {
    await params.send(false);
    return;
  }

  try {
    const messageId = await params.send(true);
    if (!messageId) throw new Error("The provider did not confirm the reply");
  } catch (error) {
    await cacheManager.withLock(key, async (cache) => {
      if ((await cache.get<string>(leaseKey)) === token) {
        await cache.delete(leaseKey);
      }
    });
    throw error;
  }

  await cacheManager.withLock(key, async (cache) => {
    if ((await cache.get<string>(leaseKey)) !== token) {
      throw new Error("The conversation reply delivery lease expired");
    }
    // The posted anchor outlives idle timeouts and runtime replacement.
    await cache.set(key, true, 0);
    await cache.delete(leaseKey);
  });
}
