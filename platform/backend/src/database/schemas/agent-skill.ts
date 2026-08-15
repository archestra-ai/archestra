import { pgTable, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import skillsTable from "./skill";

/**
 * Explicit per-agent skill assignments — the "Custom" skill mode, mirroring
 * `agent_tools`. While `agents.access_all_skills` is off, exactly these skills
 * are exposed over the gateway's `skill://` resource surface; the assigned set
 * is the authority and deliberately diverges from environment/team visibility.
 *
 * Rows are inert while `access_all_skills` is on (that mode resolves org-scoped
 * skills dynamically, minus `agent_excluded_skills`), so toggling the mode never
 * discards a Custom selection.
 */
const agentSkillsTable = pgTable(
  "agent_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [unique().on(table.agentId, table.skillId)],
);

export default agentSkillsTable;
