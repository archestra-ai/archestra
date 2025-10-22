import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { McpServerMetadata } from "@/types/mcp-server";
import mcpCatalogTable from "./mcp-catalog";

const mcpServerTable = pgTable("mcp_server", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  catalogId: uuid("catalog_id").references(() => mcpCatalogTable.id, {
    onDelete: "set null",
  }),
  metadata: jsonb("metadata").$type<McpServerMetadata>().notNull().default({}),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default mcpServerTable;
