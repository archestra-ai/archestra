import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import mcpCatalogTable from "./internal-mcp-catalog";
import secretTable from "./secret";

const mcpServerTable = pgTable("mcp_server", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  catalogId: uuid("catalog_id").references(() => mcpCatalogTable.id, {
    onDelete: "set null",
  }),
  secretId: uuid("secret_id").references(() => secretTable.id, {
    onDelete: "set null",
  }),
  reinstallRequired: boolean("reinstall_required").notNull().default(false),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default mcpServerTable;
