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
