import { pgTable, primaryKey, timestamp, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import skillsTable from "./skill";

/**
 * Per-agent single-skill exclusions for Auto-skill mode ("access all skills").
 * While `agents.access_all_skills` is on, an excluded skill is removed from the
 * agent's `skill://` surface even though Auto would otherwise resolve it
 * (`agent_skills` assignments stay untouched so Custom mode is unaffected).
 * Rows are inert when the setting is off.
 */
const agentExcludedSkillsTable = pgTable(
  "agent_excluded_skills",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.skillId] }),
  }),
);

export default agentExcludedSkillsTable;
