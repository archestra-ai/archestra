import { index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

/**
 * Stores context compaction records for long-running conversations.
 * When a conversation grows beyond the context window threshold, older messages
 * are summarized and stored here. The summary is re-injected as a system message
 * on the next request so the agent retains continuity without the full message history.
 */
const conversationCompactionsTable = pgTable(
  "conversation_compactions",
  {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  /**
   * Number of messages that were compacted into this summary.
   */
  compactedMessageCount: integer("compacted_message_count").notNull(),
  /**
   * Natural-language summary of the compacted messages.
   */
  summary: text("summary").notNull(),
  /**
   * Snapshot of compacted message IDs in order, for audit / debugging.
   */
  compactedMessageIds: jsonb("compacted_message_ids")
    .$type<string[]>()
    .notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdIdx: index(
      "conversation_compactions_conversation_id_idx",
    ).on(table.conversationId),
  }),
);

export default conversationCompactionsTable;
