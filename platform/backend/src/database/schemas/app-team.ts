import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import appsTable from "./app";
import { team } from "./team";

/**
 * Team assignments for `scope = 'team'` apps. An app is visible to and managed
 * by members of any team it is assigned to. Mirrors `agent_team`/`skill_team`.
 */
const appTeamTable = pgTable(
  "app_team",
  {
    appId: uuid("app_id")
      .notNull()
      .references(() => appsTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.appId, table.teamId] }),
  }),
);

export default appTeamTable;
