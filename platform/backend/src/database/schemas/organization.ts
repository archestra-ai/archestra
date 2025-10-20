import { boolean, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const organizationsTable = pgTable("organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  logo: text("logo"),
  createdAt: timestamp("created_at").notNull(),
  metadata: text("metadata"),
  hasSeededMcpCatalog: boolean("has_seeded_mcp_catalog")
    .default(false)
    .notNull(),
});

export default organizationsTable;
