import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

const messagesTable = pgTable("messages", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  // biome-ignore lint/suspicious/noExplicitAny: Stores complete UIMessage structure from AI SDK which is dynamic
  content: jsonb("content").$type<any>().notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" }),
});

export default messagesTable;
