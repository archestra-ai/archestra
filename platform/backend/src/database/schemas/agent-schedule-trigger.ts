import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Agent Schedule Trigger table
 * Stores scheduled triggers for agents with cron-based execution
 */
const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /** Cron expression for scheduling (e.g., "0 9 * * *" for daily at 9 AM) */
    schedule: text("schedule").notNull(),
    /** The message/prompt to send to the agent when triggered */
    message: text("message").notNull(),
    /** Optional JSON payload with additional configuration */
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    /** Whether the trigger is currently enabled */
    enabled: boolean("enabled").notNull().default(true),
    /** Timezone for cron expression evaluation (e.g., "America/New_York") */
    timezone: text("timezone").default("UTC"),
    /** Timestamp of the last successful execution */
    lastRunAt: timestamp("last_run_at", { mode: "date" }),
    /** Timestamp of the next scheduled execution */
    nextRunAt: timestamp("next_run_at", { mode: "date" }),
    /** Number of consecutive failed executions */
    consecutiveFailures: boolean("consecutive_failures").notNull().default(false),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_schedule_triggers_organization_id_idx").on(
      table.organizationId,
    ),
    index("agent_schedule_triggers_agent_id_idx").on(table.agentId),
    index("agent_schedule_triggers_enabled_idx").on(table.enabled),
  ],
);

export default agentScheduleTriggersTable;
