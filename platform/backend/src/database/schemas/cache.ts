import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import type { AllowedCacheKey } from "@/types";

/**
 * Cache table for distributed caching across multiple pods.
 *
 * This table stores ephemeral cache data with automatic TTL expiration.
 * Used for OAuth state, SSO groups, rate limiting, and other temporary data
 * that needs to be shared across multiple application instances.
 *
 * Note: Expired entries are cleaned up lazily on read and periodically by
 * a background cleanup job. The expires_at index enables efficient cleanup queries.
 */
const cacheTable = pgTable(
  "cache",
  {
    key: text("key").$type<AllowedCacheKey>().primaryKey(),
    value: jsonb("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Index for efficient cleanup of expired entries
    index("cache_expires_at_idx").on(table.expiresAt),
  ],
);

export default cacheTable;
