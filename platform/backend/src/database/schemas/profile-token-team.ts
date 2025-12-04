import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import profileTokenTable from "./profile-token";
import { team } from "./team";

/**
 * ProfileTokenTeam table - many-to-many relationship between profile tokens and teams
 * Used for team-based scoping of MCP Gateway authentication tokens
 * When a token has teams assigned, it can only access credentials from those teams
 */
const profileTokenTeamTable = pgTable(
  "profile_token_team",
  {
    tokenId: uuid("token_id")
      .notNull()
      .references(() => profileTokenTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tokenId, table.teamId] }),
  }),
);

export default profileTokenTeamTable;
