/**
 * Sticky auto-reply state for chatops channel threads.
 *
 * In channels the bot stays quiet until it is @mentioned in a thread. The
 * first mention "activates" that thread; afterwards the bot replies to every
 * message in the thread without needing another mention. Activation is stored
 * in the distributed cache with a TTL (see CHATOPS_CHANNEL_AUTO_REPLY) so
 * long-idle threads quietly stop auto-replying.
 *
 * Group chats and direct messages do not use this — the bot always replies
 * there, so callers should only consult these helpers for channel messages.
 */

import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import type { ChatOpsProviderType } from "@/types/chatops";
import { CHATOPS_CHANNEL_AUTO_REPLY } from "./constants";

/**
 * What a caller should do with a channel-style message, given the sticky
 * auto-reply flag and whether the bot was mentioned. Pure decision — the caller
 * performs the actual cache reads/writes (markChannelThreadActive /
 * isChannelThreadActive) only when the action calls for it.
 */
type ChannelGateAction =
  | "process"
  | "process-and-activate"
  | "skip"
  | "check-active";

/**
 * Resolve the sticky auto-reply gate decision for a chatops message.
 *
 * Only true channels are gated. Direct messages and multi-person group chats
 * (conversationType !== "channel") always process without activation, for both
 * flag states. Within a channel: when sticky auto-reply is disabled the bot
 * requires an explicit mention (no activation); when enabled, a mention
 * activates the thread and an un-mentioned message defers to the activation
 * cache.
 *
 * @public — exported for routes/providers and tests
 */
export function resolveChannelGateAction(params: {
  conversationType: string;
  stickyEnabled: boolean;
  wasMentioned: boolean;
}): ChannelGateAction {
  const { conversationType, stickyEnabled, wasMentioned } = params;
  if (conversationType !== "channel") {
    return "process";
  }
  if (!stickyEnabled) {
    return wasMentioned ? "process" : "skip";
  }
  if (wasMentioned) {
    return "process-and-activate";
  }
  return "check-active";
}

/** Mark a channel thread active so the bot keeps replying without a mention. */
export async function markChannelThreadActive(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<void> {
  await cacheManager.set(
    activationKey(params),
    true,
    CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS,
  );
}

/** Whether the bot was @mentioned in this channel thread recently enough to keep replying. */
export async function isChannelThreadActive(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  return (await cacheManager.get<boolean>(activationKey(params))) === true;
}

function activationKey(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): AllowedCacheKey {
  const prefix =
    params.provider === "slack"
      ? CacheKey.SlackThreadActive
      : CacheKey.TeamsThreadActive;
  return `${prefix}-${params.channelId}::${params.threadId}`;
}
