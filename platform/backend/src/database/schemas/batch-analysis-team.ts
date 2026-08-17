import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import batchAnalysesTable from "./batch-analysis";
import { team } from "./team";

/**
 * Team assignments for `scope = 'team'` batch analyses. An analysis is visible
 * to and managed by members of any team it is assigned to. Mirrors `skill_team`.
 */
const batchAnalysisTeamTable = pgTable(
  "batch_analysis_team",
  {
    batchAnalysisId: uuid("batch_analysis_id")
      .notNull()
      .references(() => batchAnalysesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.batchAnalysisId, table.teamId] }),
  }),
);

export default batchAnalysisTeamTable;
