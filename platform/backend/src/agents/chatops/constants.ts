/**
 * ChatOps constants and configuration
 */

import { TimeInMs } from "@shared";

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
  DEFAULT_LIMIT: 10,
  /** Maximum number of messages to fetch */
  MAX_LIMIT: 50,
};

/**
 * Team ID cache configuration for MS Teams
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
