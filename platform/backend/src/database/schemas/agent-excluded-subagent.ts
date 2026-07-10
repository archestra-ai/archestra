import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";

/**
 * Per-agent subagent (delegation target) exclusions for Auto-subagent mode
 * ("access all subagents"). While `agents.access_all_subagents` is on, an
 * excluded target agent is removed from the caller's delegation surface even
 * when an explicit delegation tool still exists (explicit assignments stay
 * untouched so Custom mode is unaffected). Rows are inert when the setting is
 * off. The analog of `agent_excluded_tools`, but pointing at a target agent
 * rather than a tool.
 */
const agentExcludedSubagentsTable = pgTable(
  "agent_excluded_subagents",
  {
    /** The agent whose delegation surface is being narrowed */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    /** The delegation target agent to exclude from the Auto surface */
    targetAgentId: uuid("target_agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.agentId, table.targetAgentId] })],
);

export default agentExcludedSubagentsTable;
