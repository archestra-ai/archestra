import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

const mcpCatalogTable = pgTable("mcp_catalog", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default mcpCatalogTable;
