import {
  boolean,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

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
  limitCleanupInterval: varchar("limit_cleanup_interval", {
    enum: ["1h", "12h", "24h", "1w", "1m"],
  }).default("1h"),
});

export default organizationsTable;
