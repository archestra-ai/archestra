/**
 * ChatOps constants and configuration
 */

import { TimeInMs } from "@shared";
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
 * Bot commands recognized by the chatops system
 */
/**
 * Channel discovery configuration for auto-populating channel bindings
 */
export const CHATOPS_CHANNEL_DISCOVERY = {
  /** Minimum interval between channel discovery per workspace (5 minutes) */
  TTL_MS: TimeInMs.Minute * 5,
};

/**
 * Bot commands recognized by the chatops system
 */
export const CHATOPS_COMMANDS = {
  SELECT_AGENT: "/select-agent",
  STATUS: "/status",
  HELP: "/help",
} as const;

/**
 * Native Slack slash commands.
 * These are registered in the Slack app manifest and handled by a dedicated endpoint.
 * All three share one backend endpoint — the `command` field distinguishes them.
 */
/**
 * Default connection mode for Slack when not explicitly configured.
 */
export const SLACK_DEFAULT_CONNECTION_MODE: ChatOpsConnectionMode =
  "socket" as const;

export const SLACK_SLASH_COMMANDS = {
  SELECT_AGENT: "/archestra-select-agent",
  STATUS: "/archestra-status",
  HELP: "/archestra-help",
} as const;

/**
 * Attachment limits for chatops file downloads.
 * Reuses the same limits as the incoming email module for consistency.
 */
export const CHATOPS_ATTACHMENT_LIMITS = {
  /** Maximum size for a single attachment in bytes (10MB) */
  MAX_ATTACHMENT_SIZE: 10 * 1024 * 1024,
  /** Maximum total size for all attachments per message in bytes (25MB) */
  MAX_TOTAL_ATTACHMENTS_SIZE: 25 * 1024 * 1024,
  /** Maximum number of attachments to process per message */
  MAX_ATTACHMENTS_PER_MESSAGE: 20,
} as const;
