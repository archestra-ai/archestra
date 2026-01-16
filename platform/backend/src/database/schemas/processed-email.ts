import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Table to track processed incoming emails for deduplication.
 *
 * Microsoft Graph may send multiple webhook notifications for the same email,
 * and with multiple pod replicas, each pod has its own in-memory cache.
 * This database table provides distributed deduplication across all pods.
 *
 * The messageId has a unique constraint to ensure atomic deduplication -
 * only the first INSERT will succeed, preventing race conditions.
 */
const processedEmailsTable = pgTable(
  "processed_email",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Email provider's message ID (e.g., Microsoft Graph message ID) */
    messageId: varchar("message_id", { length: 512 }).notNull().unique(),
    /** When the record was created (used for cleanup of old records) */
    processedAt: timestamp("processed_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Index on processedAt for efficient cleanup of old records
    index("processed_email_processed_at_idx").on(table.processedAt),
  ],
);

export default processedEmailsTable;
