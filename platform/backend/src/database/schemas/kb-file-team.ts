import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import kbFilesTable from "./kb-file";

/**
 * Teams a `team-scoped` file is shared with. Each row becomes a `team:<id>`
 * token on the documents indexed from this file.
 */
const kbFileTeamsTable = pgTable(
  "kb_file_team",
  {
    kbFileId: uuid("kb_file_id")
      .notNull()
      .references(() => kbFilesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kbFileId, table.teamId] }),
    index("kb_file_team_team_idx").on(table.teamId),
  ],
);

export default kbFileTeamsTable;
