/**
 * Sticky auto-reply state for MS Teams team channels.
 *
 * In team channels the bot stays quiet until it is @mentioned in a thread.
 * The first mention "activates" that thread; afterwards the bot replies to
 * every message in the thread without needing another mention. Activation is
 * stored in the distributed cache with a TTL (see CHATOPS_CHANNEL_AUTO_REPLY)
 * so long-idle threads quietly stop auto-replying.
 *
 * Group chats and direct messages do not use this — the bot always replies
 * there, so callers should only consult these helpers for `conversationType`
 * `"channel"`.
 */

import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import { CHATOPS_CHANNEL_AUTO_REPLY } from "./constants";

/** Mark a channel thread active so the bot keeps replying without a mention. */
export async function markChannelThreadActive(
  channelId: string,
  threadId: string,
): Promise<void> {
  await cacheManager.set(
    activationKey(channelId, threadId),
    true,
    CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS,
  );
}

/** Whether the bot was @mentioned in this channel thread recently enough to keep replying. */
export async function isChannelThreadActive(
  channelId: string,
  threadId: string,
): Promise<boolean> {
  return (
    (await cacheManager.get<boolean>(activationKey(channelId, threadId))) ===
    true
  );
}

function activationKey(channelId: string, threadId: string): AllowedCacheKey {
  return `${CacheKey.TeamsThreadActive}-${channelId}::${threadId}`;
}
