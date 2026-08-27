import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import pluginsTable from "./plugin";

/** Append-only activation log for Skills projected from plugin file trees. */
const pluginSkillUsageEventsTable = pgTable(
  "plugin_skill_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pluginId: uuid("plugin_id")
      .notNull()
      .references(() => pluginsTable.id, { onDelete: "cascade" }),
    skillPath: text("skill_path").notNull(),
    userId: text("user_id"),
    sessionId: text("session_id"),
    contextTokens: integer("context_tokens"),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("plugin_skill_usage_plugin_path_created_idx").on(
      table.pluginId,
      table.skillPath,
      table.createdAt,
    ),
  ],
);

export default pluginSkillUsageEventsTable;
