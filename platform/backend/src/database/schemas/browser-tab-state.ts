import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

const browserTabStatesTable = pgTable(
  "browser_tab_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    isolationKey: text("isolation_key").notNull(),
    url: text("url"),
    tabIndex: integer("tab_index"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("browser_tab_states_agent_user_isolation_idx").on(
      table.agentId,
      table.userId,
      table.isolationKey,
    ),
    index("browser_tab_states_user_id_idx").on(table.userId),
  ],
);

export default browserTabStatesTable;
