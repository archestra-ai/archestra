import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

const agentAccessControlTable = pgTable(
  "agent_access_control",
  {
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.agentId, table.userId] }),
  }),
);

export default agentAccessControlTable;
