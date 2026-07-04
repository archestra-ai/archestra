import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import toolsTable from "./tool";

/**
 * Per-agent single-tool exclusions for Auto-tool mode ("access all tools").
 * While `agents.access_all_tools` is on, an excluded tool is removed from the
 * agent's tool surface even when an agent_tools assignment row still exists
 * (assignments stay untouched so Custom mode is unaffected). Rows are inert
 * when the setting is off.
 */
const agentExcludedToolsTable = pgTable(
  "agent_excluded_tools",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => toolsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.toolId] }),
  }),
);

export default agentExcludedToolsTable;
