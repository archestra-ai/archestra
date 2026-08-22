import {
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import pluginsTable from "./plugin";
import { team } from "./team";

const pluginTeamsTable = pgTable(
  "plugin_team",
  {
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    teamId: text("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pluginId, table.teamId] }),
  }),
);

export default pluginTeamsTable;
