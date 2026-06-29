import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Table to track processed chatops messages for deduplication.
 *
 * Chatops providers may send multiple webhook notifications for the same message,
 * and with multiple pod replicas, each pod has its own in-memory cache.
 * This database table provides distributed deduplication across all pods.
 *
 * The messageId has a unique constraint to ensure atomic deduplication -
 * only the first INSERT will succeed, preventing race conditions.
 *
 * Same pattern as processed_email table.
 */
const chatopsProcessedMessagesTable = pgTable(
  "chatops_processed_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Provider's message ID (e.g., Teams activity ID) */
    messageId: varchar("message_id", { length: 512 }).notNull().unique(),
    /** When the record was created (used for cleanup of old records) */
    processedAt: timestamp("processed_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // Index on processedAt for efficient cleanup of old records
    index("chatops_processed_message_processed_at_idx").on(table.processedAt),
  ],
);

export default chatopsProcessedMessagesTable;
