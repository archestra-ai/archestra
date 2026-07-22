import {
  index,
  pgTable,
  primaryKey,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import environmentsTable from "./environment";
import skillsTable from "./skill";

/**
 * Environment assignments for skills. A skill with NO rows here is available
 * to agents in every environment (including the Default one); a skill with
 * rows is visible only to agents whose environment is one of them. The org
 * Default environment has no `environments` row (it is the null environment),
 * so it cannot be assigned here — restricting a skill to specific environments
 * hides it from Default-environment agents. Mirrors `skill_team`.
 *
 * ON DELETE CASCADE: deleting an environment removes the assignment; a skill
 * whose last assignment is removed becomes available everywhere.
 */
const skillEnvironmentTable = pgTable(
  "skill_environment",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    environmentId: uuid("environment_id")
      .notNull()
      .references(() => environmentsTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.skillId, table.environmentId] }),
    // the environment-visibility predicate probes by environment_id.
    index("skill_environment_environment_id_idx").on(table.environmentId),
  ],
);

export default skillEnvironmentTable;
