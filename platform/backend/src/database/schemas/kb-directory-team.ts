import { index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import kbDirectoriesTable from "./kb-directory";

/**
 * Teams a `team-scoped` directory is shared with. Each row becomes a
 * `team:<id>` token on the documents indexed from that directory's files.
 */
const kbDirectoryTeamsTable = pgTable(
  "kb_directory_team",
  {
    directoryId: uuid("directory_id")
      .notNull()
      .references(() => kbDirectoriesTable.id, { onDelete: "cascade" }),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.directoryId, table.teamId] }),
    index("kb_directory_team_team_idx").on(table.teamId),
  ],
);

export default kbDirectoryTeamsTable;
