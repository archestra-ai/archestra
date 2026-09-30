import {
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import chatopsBotsTable from "./chatops-bot";

/**
 * Table to track processed chatops messages for deduplication.
 *
 * Chatops providers may send multiple webhook notifications for the same message,
 * and with multiple pod replicas, each pod has its own in-memory cache.
 * This database table provides distributed deduplication across all pods.
 *
 * The (botId, messageId) pair has a unique constraint to ensure atomic
 * deduplication - only the first INSERT will succeed, preventing race
 * conditions. The bot is part of the key because one delivery can reach
 * several bots in the same channel, and each bot must process its own copy.
 *
 * Same pattern as processed_email table.
 */
const chatopsProcessedMessagesTable = pgTable(
  "chatops_processed_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Bot that claimed the message (NULL for receipts from before bots existed) */
    botId: uuid("bot_id").references(() => chatopsBotsTable.id, {
      onDelete: "cascade",
    }),
    /** Provider's message ID (e.g., Teams activity ID) */
    messageId: varchar("message_id", { length: 512 }).notNull(),
    /** When the record was created (used for cleanup of old records) */
    processedAt: timestamp("processed_at", { mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("chatops_processed_message_bot_message_uq")
      .on(table.botId, table.messageId)
      .nullsNotDistinct(),
    // Index on processedAt for efficient cleanup of old records
    index("chatops_processed_message_processed_at_idx").on(table.processedAt),
  ],
);

export default chatopsProcessedMessagesTable;
