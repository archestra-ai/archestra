import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import skillsTable from "./skill";
import { team } from "./team";

/**
 * Team assignments for `scope = 'team'` skills. A skill is visible to and
 * managed by members of any team it is assigned to. Mirrors `agent_team`.
 */
const skillTeamTable = pgTable(
  "skill_team",
  {
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skillsTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.skillId, table.teamId] }),
  }),
);

export default skillTeamTable;
