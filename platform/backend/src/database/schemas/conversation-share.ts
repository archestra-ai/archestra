import { pgEnum, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import conversationsTable from "./conversation";

export const conversationShareVisibilityEnum = pgEnum(
  "conversation_share_visibility",
  ["organization"],
);

const conversationSharesTable = pgTable("conversation_shares", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversationsTable.id, { onDelete: "cascade" })
    .unique(),
  organizationId: text("organization_id").notNull(),
  createdByUserId: text("created_by_user_id").notNull(),
  visibility: conversationShareVisibilityEnum("visibility")
    .notNull()
    .default("organization"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
});

export default conversationSharesTable;
