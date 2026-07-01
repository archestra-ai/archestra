import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import organizationsTable from "./organization";

/**
 * Legacy preset table — the MCP-catalog "preset" feature was removed; this
 * table is retained inert (non-destructive, no migration) and is no longer
 * read or written by application code. It held an org-level list of named
 * preset entries that catalog items attached per-environment configuration to.
 */
const mcpPresetEntriesTable = pgTable(
  "mcp_preset_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    /**
     * Legacy preset column (feature removed) — retained inert. Held an
     * optional JS-compatible regex source (no delimiters/flags) that
     * validated field values at install time. No longer read or written.
     */
    validationRegex: text("validation_regex"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    unique("mcp_preset_entry_org_name_unique").on(
      table.organizationId,
      table.name,
    ),
    index("mcp_preset_entry_org_idx").on(table.organizationId),
  ],
);

export default mcpPresetEntriesTable;
