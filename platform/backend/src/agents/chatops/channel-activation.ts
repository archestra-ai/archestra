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

import { randomUUID } from "node:crypto";
import { TimeInMs } from "@archestra/shared";
import {
  type AllowedCacheKey,
  CacheKey,
  cacheManager,
  LRUCacheManager,
} from "@/cache-manager";
import logger from "@/logging";
import ChatOpsChannelBindingModel from "@/models/chatops-channel-binding";
import OrganizationModel from "@/models/organization";
import type { ChatOpsProviderType } from "@/types/chatops";
import { chatOpsRunRegistry } from "./chatops-run-registry";
import { CHATOPS_CHANNEL_AUTO_REPLY } from "./constants";
import { errorMessage } from "./utils";

/**
 * Mark a channel thread active so the bot keeps replying without a mention.
 *
 * @public — applyChannelGate is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
 */
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

/**
 * Whether the bot was @mentioned in this channel thread recently enough to keep replying.
 *
 * @public — applyChannelGate is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
 */
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
 *
 * @public — the primitive muteChannelThread builds on; also exercised directly
 * in channel-activation.test.ts (knip --production can't see the test consumer).
 */
export async function clearChannelThreadActive(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  return await cacheManager.delete(activationKey(params));
}

/**
 * Mute a channel thread — the single side-effecting entry point both providers
 * use when a user asks the bot to be quiet (a mute command, a mute reaction, or
 * a "Mute this thread" button). It does three things, in order:
 *
 *  1. Records a fresh mute marker in the distributed cache. Every in-flight
 *     agent run re-reads this marker before posting and drops its reply if it
 *     changed since the run began (see getThreadMuteMarker) — so a mute is never
 *     followed by a late answer, even for a run executing on another pod.
 *  2. Aborts in-flight runs for this thread on THIS pod, stopping their model
 *     requests immediately instead of letting them finish unseen.
 *  3. Drops the sticky auto-reply activation, so future un-mentioned messages
 *     stay quiet.
 *  4. Records the answer-all mute marker, which is what keeps an answer-all
 *     channel quiet — it has no mention-driven activation for step 3 to clear.
 *     Set unconditionally: the marker is only read when a channel answers all
 *     messages (see resolveChannelGateAction), so it is inert in a
 *     mentions-only channel and already correct if the setting is later
 *     enabled. Doing it here means every mute path — command, reaction, or
 *     "Mute this thread" button — persists the mute by construction.
 *
 * Returns whether the thread was active (i.e. whether this actually muted it),
 * so callers post the "muted" confirmation ONLY on a true active→muted
 * transition, exactly like clearChannelThreadActive.
 */
export async function muteChannelThread(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  await recordThreadMute(params);
  chatOpsRunRegistry.cancelThread(params);
  await markChannelThreadMuted(params);
  return await clearChannelThreadActive(params);
}

// =============================================================================
// Per-channel "answer all messages" mode
// =============================================================================

/**
 * Whether a channel has the per-channel "answer all messages" setting enabled,
 * briefly cached so a busy channel doesn't hit the DB for every un-mentioned
 * message the gate would otherwise ignore. The default — no binding, or the flag
 * off — is false (mentions-only). The cache is short-lived and also invalidated
 * on toggle (see invalidateChannelAnswerAll), so a change takes effect promptly.
 *
 * @public — applyChannelGate is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
 */
export async function isChannelAnswerAllEnabled(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  workspaceId: string | null;
}): Promise<boolean> {
  const key = answerAllKey(params);
  const cached = await cacheManager.get<boolean>(key);
  if (cached !== undefined) return cached;
  const binding = await ChatOpsChannelBindingModel.findByChannel(params);
  const enabled = binding?.answerAllMessages === true;
  await cacheManager.set(key, enabled, ANSWER_ALL_CACHE_TTL_MS);
  return enabled;
}

/** Drop the cached "answer all messages" flag so a toggle takes effect promptly. */
export async function invalidateChannelAnswerAll(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  workspaceId: string | null;
}): Promise<void> {
  await cacheManager.delete(answerAllKey(params));
}

/**
 * Remember that a workspace delivered an un-mentioned channel message.
 *
 * On MS Teams that delivery is only possible once a team owner has consented to
 * the RSC permission for reading channel messages, so it is positive proof the
 * consent exists — which is what "answer all messages" depends on. Recording it
 * lets the UI point at a channel whose setting may be silently inert.
 *
 * The signal is one-directional: its absence is NOT evidence consent is missing,
 * only that nothing has arrived yet. A quiet channel looks identical, and so
 * does a busy one whose messages all land in threads the bot was already
 * @mentioned in — those resolve without consulting the setting, so they never
 * reach this. Callers must never disable the setting on that basis.
 */
export async function recordUnmentionedChannelTraffic(params: {
  provider: ChatOpsProviderType;
  workspaceId: string | null;
}): Promise<void> {
  const key = unmentionedTrafficKey(params);
  // Every un-mentioned channel message reaches this, and the distributed cache
  // is Postgres-backed — so an unconditional write would serialize a busy team's
  // traffic on one row's lock to re-assert a fact that lasts a month. Refreshing
  // at most once per pod per window keeps the marker fresh at negligible cost.
  if (recentlyRecordedTraffic.get(key)) return;
  // Throttle only after the write lands, so a failed one is retried by the next
  // message rather than suppressed for the whole window.
  await cacheManager.set(key, true, UNMENTIONED_TRAFFIC_TTL_MS);
  recentlyRecordedTraffic.set(key, true);
}

export async function findWorkspacesWithUnmentionedTraffic(params: {
  provider: ChatOpsProviderType;
  workspaceIds: string[];
}): Promise<string[]> {
  const seen = await Promise.all(
    params.workspaceIds.map(async (workspaceId) =>
      (await cacheManager.get<boolean>(
        unmentionedTrafficKey({ provider: params.provider, workspaceId }),
      )) === true
        ? workspaceId
        : null,
    ),
  );
  return seen.filter((id): id is string => id !== null);
}

/**
 * Mute a thread in an answer-all channel so the bot stays quiet there until it
 * is @mentioned again.
 *
 * Answer-all channels reply without needing a mention, so the mention-driven
 * sticky activation the normal gate mutes by clearing (clearChannelThreadActive)
 * does not apply — a thread has to remember it was muted on its own. This marker
 * is that memory: the gate consults isChannelThreadMuted for un-mentioned
 * messages and stays quiet while it is set, and a fresh @mention clears it (see
 * clearChannelThreadMuted).
 *
 * @public — muteChannelThread is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
 */
export async function markChannelThreadMuted(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<void> {
  await cacheManager.set(
    mutedKey(params),
    true,
    CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS,
  );
}

/**
 * Whether an answer-all channel thread was muted and not yet re-mentioned.
 *
 * @public — applyChannelGate is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
 */
export async function isChannelThreadMuted(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  return (await cacheManager.get<boolean>(mutedKey(params))) === true;
}

/**
 * Clear an answer-all thread's mute marker so the bot resumes replying. Called
 * on a fresh @mention (a re-mention is an explicit "answer here again").
 *
 * @public — exercised directly in channel-activation.test.ts (knip --production
 * can't see the test consumer).
 */
export async function clearChannelThreadMuted(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<boolean> {
  return await cacheManager.delete(mutedKey(params));
}

/**
 * Read the current mute marker for a channel thread, or null if none is set.
 *
 * The marker is an opaque token rewritten on every mute (see muteChannelThread).
 * Callers capture it when a run starts and compare it just before replying: a
 * non-null value that differs from the captured one means the thread was muted
 * mid-run, so the reply must be suppressed. Comparing the shared token (never a
 * local clock) makes this correct across pods without clock-skew assumptions,
 * and a null current value is never treated as a mute, so a lapsed marker can't
 * cause a spurious suppression.
 */
export async function getThreadMuteMarker(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<string | null> {
  return (await cacheManager.get<string>(muteMarkerKey(params))) ?? null;
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
 *
 * @public — applyChannelGate is the only production caller; the phrase matching
 * has its own suite in channel-activation.test.ts (knip can't see tests).
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
 *
 * @public — applyChannelGate is the only production caller; also exercised
 * directly in channel-activation.test.ts (knip --production can't see tests).
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

type ChannelGateAction = "mute" | "activate" | "process" | "ignore";

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
 *
 * `answerAll` reflects a per-channel "answer all messages" setting: when true the
 * bot replies to every message in the channel, not only mentions. It only
 * changes the un-mentioned + inactive case (normally "ignore"): the message is
 * processed unless the thread has been muted (`isMuted`), and a mute command is
 * still honored. Mention/active behavior is unchanged, so a mentions-only
 * channel (answerAll false, the default) keeps its exact prior semantics.
 *
 * @public — kept separate from applyChannelGate (its only production caller) so
 * the branching stays pure and testable; its truth table lives in
 * channel-activation.test.ts, which knip --production cannot see.
 */
export function resolveChannelGateAction(params: {
  botMentioned: boolean;
  wantsMute: boolean;
  isActive: boolean;
  answerAll?: boolean;
  isMuted?: boolean;
}): ChannelGateAction {
  if (params.botMentioned) return params.wantsMute ? "mute" : "activate";
  if (params.isActive) return params.wantsMute ? "mute" : "process";
  if (params.answerAll) {
    if (params.wantsMute) return "mute";
    return params.isMuted ? "ignore" : "process";
  }
  return "ignore";
}

/**
 * Run the full channel gate for an inbound message: decide via
 * resolveChannelGateAction and apply that action's state transitions.
 *
 * Every provider gates channel messages the same way, so this owns the whole
 * sequence — the reads, the branch, and all cache writes (muteChannelThread,
 * markChannelThreadActive, clearChannelThreadMuted). Callers supply only what
 * is provider-specific: how to post the "muted" confirmation, and how to reach
 * the workspace id the "answer all messages" setting is stored under.
 *
 * Reads are ordered so a mentions-only channel — the default — does no work
 * beyond the single activation lookup: the app name is resolved only for a
 * message that might be an addressed mute command, the activation only when the
 * bot wasn't mentioned, the answer-all setting only when it could change the
 * outcome, and the thread's mute marker only when answer-all is in play.
 *
 * `text` must already have the bot mention stripped, so a bare "@bot mute"
 * matches the mute commands.
 *
 * Returns `proceed` — whether the message should be handled at all — and
 * `addressed`, which is false when the message reached the agent ONLY because
 * the channel answers every message. Callers use `addressed` to stay quiet
 * about things the sender never asked for (see the Teams webhook route).
 */
export async function applyChannelGate(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
  botMentioned: boolean;
  text: string;
  /**
   * The bot's name as the provider displays it, so it answers to the name people
   * actually see. Distinct from the organization's app name, which is a branding
   * setting and can differ (or be white-labelled to something else entirely).
   */
  botDisplayName?: string | null;
  postMutedNotice: () => Promise<void>;
  resolveAnswerAllWorkspaceId: () => Promise<string | null>;
}): Promise<{ proceed: boolean; addressed: boolean }> {
  const { provider, channelId, threadId, botMentioned, text } = params;
  const activation = { provider, channelId, threadId };

  let wantsMute = isThreadMuteCommand(text);
  if (!wantsMute && mightBeAddressedMuteCommand(text)) {
    wantsMute = isThreadMuteCommand(text, [
      await OrganizationModel.getAppName(),
      ...(params.botDisplayName ? [params.botDisplayName] : []),
    ]);
  }
  const isActive = botMentioned
    ? false
    : await isChannelThreadActive(activation);
  // Reading the setting needs the DB and, for Teams, a Bot Framework call. Treat
  // a failure as mentions-only rather than letting it throw: quiet is the safe
  // default, and it must never abort a mute before muteChannelThread has
  // cancelled the in-flight runs — a lost confirmation notice beats a late reply
  // arriving after someone asked for quiet.
  let answerAll = false;
  if ((!botMentioned && !isActive) || wantsMute) {
    try {
      answerAll = await isChannelAnswerAllEnabled({
        provider,
        channelId,
        workspaceId: await params.resolveAnswerAllWorkspaceId(),
      });
    } catch (error) {
      logger.warn(
        { error: errorMessage(error), provider, channelId },
        "[ChatOps] Could not read the answer-all setting; treating the channel as mentions-only",
      );
    }
  }
  const isMuted =
    answerAll && !botMentioned && !isActive && !wantsMute
      ? await isChannelThreadMuted(activation)
      : false;

  switch (
    resolveChannelGateAction({
      botMentioned,
      wantsMute,
      isActive,
      answerAll,
      isMuted,
    })
  ) {
    case "mute": {
      // muteChannelThread persists the mute marker, so the thread's prior state
      // has to be read before it — the confirmation is one-shot per mute, and an
      // answer-all thread that was never "active" still deserves one. Only the
      // notice depends on this, so a read failure must not hold up the mute.
      const alreadyMuted = answerAll
        ? await isChannelThreadMuted(activation).catch(() => false)
        : false;
      const wasActive = await muteChannelThread(activation);
      if (wasActive || (answerAll && !alreadyMuted)) {
        await params.postMutedNotice();
      }
      return { proceed: false, addressed: false };
    }
    case "activate":
      await markChannelThreadActive(activation);
      // A re-mention lifts an answer-all mute.
      await clearChannelThreadMuted(activation);
      return { proceed: true, addressed: true };
    case "process":
      return { proceed: true, addressed: isActive };
    case "ignore":
      return { proceed: false, addressed: false };
  }
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

function mutedKey(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): AllowedCacheKey {
  const prefix =
    params.provider === "slack"
      ? CacheKey.SlackThreadMuted
      : CacheKey.TeamsThreadMuted;
  return `${prefix}-${params.channelId}::${params.threadId}`;
}

function answerAllKey(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  workspaceId: string | null;
}): AllowedCacheKey {
  return `${CacheKey.ChatOpsChannelAnswerAll}-${params.provider}::${params.workspaceId ?? ""}::${params.channelId}`;
}

function unmentionedTrafficKey(params: {
  provider: ChatOpsProviderType;
  workspaceId: string | null;
}): AllowedCacheKey {
  return `${CacheKey.TeamsUnmentionedChannelTraffic}-${params.provider}::${params.workspaceId ?? ""}`;
}

/**
 * How long the "this workspace delivers un-mentioned messages" proof lives. Long
 * enough that a workspace which chats on most days keeps the marker fresh, so a
 * normally-active team never sees the hint; short enough that the marker cannot
 * outlive an app being reinstalled without consent.
 */
const UNMENTIONED_TRAFFIC_TTL_MS = 30 * TimeInMs.Day;

/**
 * Per-pod record of workspaces whose marker was refreshed recently, so a busy
 * team writes to the distributed cache once an hour instead of once a message
 * (see recordUnmentionedChannelTraffic). Sized for far more workspaces than one
 * deployment has; an eviction only costs one redundant write.
 */
const recentlyRecordedTraffic = new LRUCacheManager<boolean>({
  maxSize: 1_000,
  defaultTtl: TimeInMs.Hour,
});

/**
 * How long the per-channel "answer all messages" flag stays cached. Short enough
 * that a stale read self-heals quickly even if an invalidation is missed, long
 * enough to spare a busy channel a DB read on every message.
 */
const ANSWER_ALL_CACHE_TTL_MS = 60_000;

/** Write a fresh mute token so in-flight runs observe the thread was just muted. */
async function recordThreadMute(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): Promise<void> {
  await cacheManager.set(
    muteMarkerKey(params),
    randomUUID(),
    THREAD_MUTE_MARKER_TTL_MS,
  );
}

function muteMarkerKey(params: {
  provider: ChatOpsProviderType;
  channelId: string;
  threadId: string;
}): AllowedCacheKey {
  const prefix =
    params.provider === "slack"
      ? CacheKey.SlackThreadMuteMarker
      : CacheKey.TeamsThreadMuteMarker;
  return `${prefix}-${params.channelId}::${params.threadId}`;
}

/**
 * How long a mute marker lives. Only needs to outlast the longest single agent
 * turn so a run started before a mute still observes the marker when it replies;
 * correctness never depends on the exact value (a lapsed marker reads as null,
 * which is treated as "not muted"), so a generous window is safe.
 */
const THREAD_MUTE_MARKER_TTL_MS = CHATOPS_CHANNEL_AUTO_REPLY.ACTIVE_TTL_MS;

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
