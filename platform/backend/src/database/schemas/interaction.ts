import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { InteractionContent } from "@/types";
import chatsTable from "./chat";

const interactionsTable = pgTable(
  "interactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chatsTable.id, { onDelete: "cascade" }),
    content: jsonb("content").$type<InteractionContent>().notNull(),
    trusted: boolean("trusted").notNull().default(true),
    blocked: boolean("blocked").notNull().default(false),
    reason: text("reason"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    chatIdIdx: index("interactions_chat_id_idx").on(table.chatId),
  }),
);

export default interactionsTable;
