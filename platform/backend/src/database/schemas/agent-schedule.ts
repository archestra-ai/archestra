import { pgTable, text, timestamp, uuid, boolean } from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import toolsTable from "./tool";

const agentSchedulesTable = pgTable(
  "agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    cron: text("cron").notNull(),
    nextRunAt: timestamp("next_run_at", { mode: "date" }),
    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    enabled: boolean("enabled").notNull().default(true),
    /** 
     * Optional: Pre-flight check tool. 
     * If set, the full agent run only triggers if this tool returns "new data" indicator.
     */
    conditionToolId: uuid("condition_tool_id").references(() => toolsTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  }
);

export default agentSchedulesTable;
