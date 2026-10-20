import { CacheKey, cacheManager } from "@/cache-manager";
import type { IncomingChatMessage } from "@/types/chatops";
import { CHATOPS_MESSAGE_RETENTION } from "./constants";

/** Keep only the routing needed to post later through the same Teams bot. */
export async function rememberFileDeliveryContext(
  bindingId: string,
  message: Pick<IncomingChatMessage, "channelId" | "threadId" | "metadata">,
): Promise<void> {
  const conversationReference = message.metadata?.conversationReference;
  if (!conversationReference) return;
  const threadId = message.threadId ?? message.channelId;
  await cacheManager.set(
    `${CacheKey.ChatOpsFileDelivery}-${bindingId}-${threadId}`,
    { conversationReference },
    CHATOPS_MESSAGE_RETENTION.RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
}

export function getFileDeliveryContext(bindingId: string, threadId: string) {
  return cacheManager.get<{ conversationReference: unknown }>(
    `${CacheKey.ChatOpsFileDelivery}-${bindingId}-${threadId}`,
  );
}
