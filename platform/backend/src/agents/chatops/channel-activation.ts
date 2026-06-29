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
 *
 * A user can end the sticky behavior early — a mute command (see
 * isThreadMuteCommand), a mute reaction on a bot reply (see isMuteReaction), or
 * a "Mute this thread" button all call clearChannelThreadActive, which drops the
 * activation so the bot goes quiet until it is @mentioned again.
 */

import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import type { ChatOpsProviderType } from "@/types/chatops";
import { CHATOPS_CHANNEL_AUTO_REPLY } from "./constants";

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

/**
 * Stop the bot auto-replying in a channel thread until it is @mentioned again.
 *
 * Returns whether the thread was active (i.e. whether this call actually muted
 * it). Callers post the "muted" confirmation ONLY on a true active→muted
 * transition, so redelivered events and double-clicks don't spam the thread and
 * a no-op mute (already muted / never active) stays silent.
 */
export async function clearChannelThreadActive(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  return await cacheManager.delete(activationKey(params));
}

/**
 * Whether a message is a request to mute the bot in the current channel thread.
 *
 * The match is against the whole mention-stripped message, normalized to lower
 * case with surrounding whitespace and trailing punctuation removed. Requiring
 * the ENTIRE message to be one of these phrases keeps it unambiguous — "stop
 * the deployment" is a real request, not a mute — so false positives are
 * essentially impossible without resorting to brittle natural-language intent
 * detection. "mute" is the canonical command; the rest are friendly aliases.
 */
export function isThreadMuteCommand(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[\s.!?]+$/, "");
  return THREAD_MUTE_COMMANDS.has(normalized);
}

/**
 * Whether an emoji reaction on a bot reply means "mute this thread".
 *
 * Accepts either platform's identifier for the same two glyphs: 🔇 muted
 * speaker (Slack `mute`, Teams `1f507_mutedspeaker`) and 🤫 shushing face
 * (Slack `shushing_face`, Teams `lipssealed`). Matching a single shared Set
 * avoids a per-provider mapping. Callers gate on the reaction being on the
 * bot's OWN message before consulting this.
 */
export function isMuteReaction(reactionId: string): boolean {
  return THREAD_MUTE_REACTIONS.has(reactionId.trim().toLowerCase());
}

// =============================================================================
// Internal Helpers
// =============================================================================

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

/**
 * Whole-message phrases that mute the bot in a channel thread. Kept short and
 * unambiguous so they don't collide with real requests (see isThreadMuteCommand).
 */
const THREAD_MUTE_COMMANDS = new Set([
  "mute",
  "/mute",
  "mute thread",
  "mute this thread",
  "stop replying",
  "stop responding",
  "stop auto-replying",
  "stand down",
  "be quiet",
  "stay quiet",
]);

/**
 * Emoji reaction identifiers that mute a thread, across both providers (see
 * isMuteReaction): 🔇 muted speaker and 🤫 shushing face. Slack sends short
 * names; Teams sends its reactionType ids.
 */
const THREAD_MUTE_REACTIONS = new Set([
  "mute", // 🔇 Slack
  "1f507_mutedspeaker", // 🔇 Teams
  "shushing_face", // 🤫 Slack
  "lipssealed", // 🤫 Teams
]);
