import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

const scheduleTriggersTable = pgTable(
  "schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    messageTemplate: text("message_template").notNull(),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    actorUserId: text("actor_user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    lastExecutedAt: timestamp("last_executed_at", {
      withTimezone: true,
      mode: "date",
    }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("schedule_triggers_agent_id_idx").on(table.agentId),
    index("schedule_triggers_actor_user_id_idx").on(table.actorUserId),
    index("schedule_triggers_enabled_last_executed_at_idx").on(
      table.enabled,
      table.lastExecutedAt,
    ),
  ],
);

export default scheduleTriggersTable;
