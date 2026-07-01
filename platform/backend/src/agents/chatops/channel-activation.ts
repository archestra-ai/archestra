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
 * Claim the one-time "you can mute me" hint slot for a channel thread.
 *
 * Returns true the FIRST time it's called for a given thread (and records that
 * the hint was shown), false thereafter — so the subtle mute hint rides only
 * the bot's first reply in a thread, not every reply. Shares the sticky
 * auto-reply TTL: once a thread goes idle long enough to stop auto-replying, a
 * later revival is effectively a fresh conversation worth hinting again.
 *
 * Get-then-set (not atomic): a rare race could show the hint twice, which is
 * harmless. Callers should only claim on a reply they're actually posting.
 *
 * A purely decorative hint must never break a reply, so a cache failure is
 * swallowed and treated as "don't hint" rather than propagated.
 */
export async function claimThreadMuteHint(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  const key = muteHintKey(params);
  try {
    if ((await cacheManager.get<boolean>(key)) === true) return false;
    await cacheManager.set(key, true, CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS);
    return true;
  } catch {
    return false;
  }
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
 *
 * `addressableNames` lets a command be prefixed by a name the bot answers to
 * (e.g. the app name: "Archestra shut up", "Acme mute") without an explicit
 * @mention — a leading addressable name is stripped before matching. Only those
 * specific names are stripped, never an arbitrary word, so "joey shut up" (aimed
 * at a person) is not treated as a mute.
 */
export function isThreadMuteCommand(
  text: string,
  addressableNames: string[] = [],
): boolean {
  const normalized = normalizeMuteText(text);
  if (THREAD_MUTE_COMMANDS.has(normalized)) return true;
  for (const name of addressableNames) {
    const prefix = name.trim().toLowerCase();
    if (prefix && normalized.startsWith(prefix)) {
      const rest = normalized.slice(prefix.length).replace(/^[\s,:]+/, "");
      if (rest && THREAD_MUTE_COMMANDS.has(rest)) return true;
    }
  }
  return false;
}

/**
 * Cheap (no I/O) check for whether a message could be an
 * "<addressable name> <mute command>" — i.e. it ends with a mute command after
 * a prefix. Lets the gate resolve the (DB-backed) app name only when it might
 * matter, instead of on every channel message.
 */
export function mightBeAddressedMuteCommand(text: string): boolean {
  const normalized = normalizeMuteText(text);
  for (const command of THREAD_MUTE_COMMANDS) {
    if (normalized.endsWith(` ${command}`)) return true;
  }
  return false;
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

/**
 * Decide what an inbound channel message should trigger, given whether the bot
 * was @mentioned, whether the message is a mute command, and whether the thread
 * is already active. Pure, so the Slack and Teams gates share — and unit-test —
 * the exact same branching instead of duplicating it.
 *
 * - "mute": a mute command while addressed or already active → drop activation
 * - "activate": a fresh @mention → start sticky auto-reply, then process
 * - "process": an un-mentioned message in an already-active thread → reply
 * - "ignore": un-mentioned and inactive → stay quiet
 */
type ChannelGateAction = "mute" | "activate" | "process" | "ignore";

export function resolveChannelGateAction(params: {
  botMentioned: boolean;
  wantsMute: boolean;
  isActive: boolean;
}): ChannelGateAction {
  if (params.botMentioned) return params.wantsMute ? "mute" : "activate";
  if (params.isActive) return params.wantsMute ? "mute" : "process";
  return "ignore";
}

// =============================================================================
// Internal Helpers
// =============================================================================

/** Normalize a message for whole-string mute-command matching. */
function normalizeMuteText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s.!?]+$/, "");
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

function muteHintKey(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): AllowedCacheKey {
  const prefix =
    params.provider === "slack"
      ? CacheKey.SlackThreadMuteHint
      : CacheKey.TeamsThreadMuteHint;
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
  "shut up",
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
