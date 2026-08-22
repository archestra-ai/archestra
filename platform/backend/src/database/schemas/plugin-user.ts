import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import pluginsTable from "./plugin";
import usersTable from "./user";

/** Named-user metadata visibility grants on personal plugins. */
const pluginUsersTable = pgTable(
  "plugin_user",
  {
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pluginId, table.userId] }),
  }),
);

export default pluginUsersTable;
