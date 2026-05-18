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
 * Org-level list of preset entries. Each entry is a named bucket (e.g.
 * "Production", "Staging") that catalog items can attach per-environment
 * configuration to. Names are immutable — the catalog UI uses the entry's
 * name verbatim as the `child_name` on per-catalog preset rows, so renaming
 * here would silently de-link existing configurations. Insert and delete only.
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
