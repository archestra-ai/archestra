/**
 * Constants for the incoming email module
 *
 * These are kept in a separate file to allow importing without triggering
 * the full module dependency chain (which includes database connections).
 */

/**
 * Interval for background job to check and renew email subscriptions
 * Microsoft Graph subscriptions expire after 3 days, so we check every 6 hours
 */
export const EMAIL_SUBSCRIPTION_RENEWAL_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Maximum email body size in bytes (100KB)
 * Emails larger than this will be truncated to prevent excessive LLM context usage
 */
export const MAX_EMAIL_BODY_SIZE = 100 * 1024; // 100KB

/**
 * TTL for processed email deduplication cache (5 minutes)
 * Microsoft Graph may send multiple notifications for the same email within seconds.
 * We track processed message IDs to prevent duplicate agent invocations.
 */
export const EMAIL_DEDUP_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
