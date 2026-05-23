import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const memoryItemsTable = pgTable(
  "memory_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    userId: text("user_id").notNull(),
    content: text("content").notNull(),
    namespace: text("namespace"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("memory_items_org_user_idx").on(table.organizationId, table.userId),
    index("memory_items_namespace_idx").on(table.namespace),
  ],
);

export default memoryItemsTable;
