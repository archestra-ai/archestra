import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";

const agentSchedulesTable = pgTable(
  "agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    payload: text("payload"),
    isActive: boolean("is_active").notNull().default(true),
    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    nextRunAt: timestamp("next_run_at", { mode: "date" }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_schedules_agent_id_idx").on(table.agentId),
    index("agent_schedules_next_run_at_idx").on(table.nextRunAt),
    index("agent_schedules_is_active_idx").on(table.isActive),
  ],
);

export default agentSchedulesTable;
