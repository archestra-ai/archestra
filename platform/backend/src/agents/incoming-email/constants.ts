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
 * Retention period for processed email records in database (24 hours)
 * Records older than this will be cleaned up to prevent unbounded table growth.
 * This is much longer than needed for deduplication (which happens within seconds)
 * to provide a safety margin and allow for debugging.
 */
export const PROCESSED_EMAIL_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Interval for cleaning up old processed email records (1 hour)
 * Should be shorter than the retention period.
 */
export const PROCESSED_EMAIL_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Default display name for agent email replies
 * Used when the agent's name is not available
 */
export const DEFAULT_AGENT_EMAIL_NAME = "Archestra Agent";

/**
 * Maximum size for a single email attachment in bytes (10MB)
 * Attachments larger than this will be skipped
 */
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB

/**
 * Maximum total size for all attachments per email in bytes (25MB)
 * Microsoft Graph API has a 25MB limit for message + attachments
 */
export const MAX_TOTAL_ATTACHMENTS_SIZE = 25 * 1024 * 1024; // 25MB

/**
 * Maximum number of attachments to process per email
 * Prevents excessive API calls and processing time
 */
export const MAX_ATTACHMENTS_PER_EMAIL = 20;

/**
 * Minimum size for image attachments in bytes (2KB)
 * Filters out broken inline image references that email clients include when
 * forwarding/replying (e.g., Outlook includes tiny ~988 byte broken references
 * to the previous message's inline images). These broken images cause LLM
 * providers like Gemini to reject the request with "Provided image is not valid".
 */
export const MIN_IMAGE_ATTACHMENT_SIZE = 2 * 1024; // 2KB
