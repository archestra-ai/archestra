import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ConversationCompactionTrigger } from "@/types/conversation-compaction";
import conversationsTable from "./conversation";

const conversationCompactionsTable = pgTable(
  "conversation_compactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    summary: text("summary").notNull(),
    compactedThroughMessageId: text("compacted_through_message_id"),
    trigger: text("trigger").$type<ConversationCompactionTrigger>().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    originalTokenEstimate: integer("original_token_estimate").notNull(),
    compactedTokenEstimate: integer("compacted_token_estimate").notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdCreatedAtIdx: index(
      "conversation_compactions_conversation_id_created_at_idx",
    ).on(table.conversationId, table.createdAt),
  }),
);

export default conversationCompactionsTable;
