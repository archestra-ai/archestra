import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { McpSkillResource } from "@/types/mcp-skill";
import internalMcpCatalogTable from "./internal-mcp-catalog";

/**
 * Catalog metadata advertised by an MCP server's `skills/list`. Like external
 * MCP Apps' tool metadata, this is discovery state only: skill bytes remain on
 * the source server and are fetched live when the skill is opened or loaded.
 */
const mcpCatalogSkillsTable = pgTable(
  "mcp_catalog_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    catalogId: uuid("catalog_id")
      .notNull()
      .references(() => internalMcpCatalogTable.id, { onDelete: "cascade" }),
    uri: text("uri").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    frontmatter: jsonb("frontmatter")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    resources: jsonb("resources").$type<McpSkillResource[] | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("mcp_catalog_skills_catalog_uri_uidx").on(
      table.catalogId,
      table.uri,
    ),
    index("mcp_catalog_skills_catalog_idx").on(table.catalogId),
  ],
);

export default mcpCatalogSkillsTable;
