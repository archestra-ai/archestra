import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";
import { openappaYellsTable } from "./openappa-yell";

export const openappaYellConversationsTable = pgTable(
  "openappa_yell_conversations",
  {
    yellId: uuid("yell_id")
      .notNull()
      .references(() => openappaYellsTable.id, { onDelete: "cascade" }),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversationsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.yellId, table.conversationId] }),
    index("openappa_yell_conversations_conversation_id_idx").on(
      table.conversationId,
    ),
  ],
);
