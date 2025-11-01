import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: jsonb("content").$type<any>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export default messagesTable;
