/**
 * ChatOps constants and configuration
 */

import { TimeInMs } from "@archestra/shared";
import {
  MAX_ATTACHMENT_SIZE,
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENTS_SIZE,
} from "@/agents/incoming-email/constants";
import type { ChatOpsConnectionMode } from "@/types";

/**
 * Rate limit configuration for chatops webhooks
 */
export const CHATOPS_RATE_LIMIT = {
  /** Rate limit window in milliseconds (1 minute) */
  WINDOW_MS: 60 * 1000,
  /** Maximum requests per window per IP */
  MAX_REQUESTS: 60,
};

/**
 * Processed message retention settings
 */
export const CHATOPS_MESSAGE_RETENTION = {
  /** How long to keep processed message records (7 days) */
  RETENTION_DAYS: 7,
  /** Cleanup interval in milliseconds (1 hour) */
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000,
};

/**
 * Thread history limits
 */
export const CHATOPS_THREAD_HISTORY = {
  /** Default number of messages to fetch for context */
  DEFAULT_LIMIT: 50,
  /** Maximum number of messages to fetch */
  MAX_LIMIT: 50,
};

/**
 * Channel-to-team mapping cache configuration
 */
export const CHATOPS_TEAM_CACHE = {
  /** Maximum number of channel-to-team mappings to cache */
  MAX_SIZE: 500,
  /** Cache TTL in milliseconds (1 hour) */
  TTL_MS: 60 * 60 * 1000,
};

/**
 * Channel discovery configuration for auto-populating channel bindings
 */
export const CHATOPS_CHANNEL_DISCOVERY = {
  /** Minimum interval between channel discovery per workspace (5 minutes) */
  TTL_MS: TimeInMs.Minute * 5,
};

/**
 * Sticky auto-reply for MS Teams team channels.
 *
 * The bot must be @mentioned to start replying in a channel thread; once
 * mentioned, it keeps replying to that thread without further mentions until
 * this TTL lapses (so stale threads stop auto-replying on their own).
 *
 * A user can also end it early — sending a mute command (see isThreadMuteCommand)
 * drops the activation so the bot goes quiet until @mentioned again.
 */
export const CHATOPS_CHANNEL_AUTO_REPLY = {
  /** How long a thread stays "active" after the last @mention (30 days) */
  ACTIVE_TTL_MS: TimeInMs.Day * 30,
};

/**
 * A randomized confirmation that a thread was muted (see channel-activation),
 * posted by both providers. The lead-in varies for a bit of personality; the
 * reassurance about how to un-mute is appended consistently so users always
 * know how to bring the bot back. Plain text (no provider-specific markup) so
 * it renders identically in Slack and MS Teams.
 */
export function buildThreadMutedNotice(): string {
  const leadIn =
    THREAD_MUTED_LEAD_INS[
      Math.floor(Math.random() * THREAD_MUTED_LEAD_INS.length)
    ];
  return `🔇 ${leadIn} — @mention me to bring me back.`;
}

const THREAD_MUTED_LEAD_INS = [
  "Got it, going quiet for now",
  "Say no more, I'll zip it",
  "Understood, standing down",
  "Cool, I'll stop chiming in",
  "On it, muting myself",
  "Roger that, I'll hush up",
  "Fair enough, I'll button it",
  "Heard you loud and clear, stepping back",
  "No problem, I'll keep to myself",
  "Done, I'll sit this thread out",
] as const;

/**
 * A subtle one-time footer hint, appended to the bot's FIRST reply in a channel
 * thread (see claimThreadMuteHint), teaching users the off switch for sticky
 * auto-reply without the verbosity of the /help command. Plain text (no
 * provider-specific markup) so it renders identically in Slack and MS Teams; the
 * 🔇 glyph matches the mute reaction users can add to any bot reply.
 */
export const THREAD_MUTE_HINT =
  'Reply "mute" or react 🔇 to any of my messages to stop auto-replies in this thread';

/**
 * In group conversations the agent hears every message but should not answer
 * every one. When it decides no reply is needed it answers with exactly this
 * token, and the chatops layer posts nothing instead of a message.
 */
export const CHATOPS_NO_REPLY_SENTINEL = "[NO_REPLY]";

/**
 * Bot commands recognized by the chatops system
 */
export const CHATOPS_COMMANDS = {
  SELECT_AGENT: "/select-agent",
  STATUS: "/status",
  HELP: "/help",
} as const;

/**
 * Default connection mode for Slack when not explicitly configured.
 */
export const SLACK_DEFAULT_CONNECTION_MODE: ChatOpsConnectionMode =
  "socket" as const;

/** @public — re-exported for testability */
export { SLACK_SLASH_COMMANDS } from "@archestra/shared";

/**
 * Attachment limits for chatops file downloads.
 * Reuses the same limits as the incoming email module for consistency.
 */
export const CHATOPS_ATTACHMENT_LIMITS = {
  MAX_ATTACHMENT_SIZE,
  MAX_TOTAL_ATTACHMENTS_SIZE,
  MAX_ATTACHMENTS_PER_MESSAGE: MAX_ATTACHMENTS_PER_EMAIL,
  /**
   * Target raw size for an image sent inline to the model. Chosen so the
   * base64-encoded payload (~+33%) stays under the ~5 MB per-image limit
   * common to vision providers (e.g. Anthropic). Oversized images are shrunk
   * to fit this before delivery; heuristic, conservative.
   */
  MAX_MODEL_INLINE_IMAGE_SIZE: 3.75 * 1024 * 1024,
  /**
   * Longest-edge cap for a shrunk image. 1568 px is the standard-tier vision
   * resolution (Anthropic), plenty for screenshot legibility and cheaper in
   * tokens/decode memory than the high-res tier — a safe default across models.
   */
  MAX_MODEL_INLINE_IMAGE_DIMENSION: 1568,
  /**
   * Upper bound on the compressed bytes we will download for an oversized
   * image in order to attempt shrinking. Bounds per-image transfer/buffer
   * memory (chatops handlers run concurrently and uncapped); an image larger
   * than this is skipped without downloading. Sized to cover phone screenshots
   * (~16 MB) with headroom. The decoded-bitmap bomb guard lives in the Rust
   * shrinker's decode limits, not here.
   */
  MAX_CONVERTIBLE_IMAGE_SIZE: 20 * 1024 * 1024,
} as const;
