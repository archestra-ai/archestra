import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import mcpServerTable from "./mcp-server";
import toolsTable from "./tool";

/**
 * The tool description one MCP server installation reported in its own
 * `tools/list`.
 *
 * `tools` rows are shared by every installation of a catalog item, so their
 * `description` holds whichever installation synced last. Some servers tailor
 * descriptions to the authenticated account (for example, naming the signed-in
 * user's ID), so callers are served the description reported by the
 * installation their calls run through, and fall back to the shared row when
 * that installation has not synced yet.
 */
const mcpServerToolDescriptionsTable = pgTable(
  "mcp_server_tool_descriptions",
  {
    mcpServerId: uuid("mcp_server_id")
      .notNull()
      .references(() => mcpServerTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    description: text("description"),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    primaryKey({ columns: [table.mcpServerId, table.toolId] }),
    index("mcp_server_tool_descriptions_tool_id_idx").on(table.toolId),
  ],
);

export default mcpServerToolDescriptionsTable;
