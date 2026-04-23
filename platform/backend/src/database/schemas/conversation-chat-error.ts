import type { ChatErrorResponse } from "@shared";
import { index, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

const conversationChatErrorsTable = pgTable(
  "conversation_chat_errors",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    error: jsonb("error").$type<ChatErrorResponse>().notNull(),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    conversationIdIdx: index("conversation_chat_errors_conversation_id_idx").on(
      table.conversationId,
    ),
  }),
);

export default conversationChatErrorsTable;
