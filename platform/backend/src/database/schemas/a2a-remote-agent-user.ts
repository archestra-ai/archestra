import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import a2aRemoteAgentsTable from "./a2a-remote-agent";
import usersTable from "./user";

const a2aRemoteAgentUsersTable = pgTable(
  "a2a_remote_agent_users",
  {
    remoteAgentId: uuid("remote_agent_id")
      .notNull()
      .references(() => a2aRemoteAgentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.remoteAgentId, table.userId] })],
);

export default a2aRemoteAgentUsersTable;
