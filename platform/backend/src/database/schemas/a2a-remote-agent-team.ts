import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aRemoteAgentsTable from "./a2a-remote-agent";
import { team } from "./team";

const a2aRemoteAgentTeamsTable = pgTable(
  "a2a_remote_agent_teams",
  {
    remoteAgentId: uuid("remote_agent_id")
      .notNull()
      .references(() => a2aRemoteAgentsTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.remoteAgentId, table.teamId] })],
);

export default a2aRemoteAgentTeamsTable;
