import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const conversationsTable = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: text("user_id").notNull(),
  organizationId: text("organization_id").notNull(),
  title: text("title"),
  selectedModel: text("selected_model").notNull().default("gpt-4o"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationsTable;
