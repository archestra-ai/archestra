import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import agentsTable from "./agent";
import usersTable from "./user";

export type TriggerType = "cron" | "interval" | "once";
export type TriggerStatus = "success" | "error";

/**
 * Stores scheduled trigger configurations for internal agents.
 *
 * Each trigger fires `executeA2AMessage()` with `inputMessage` on a schedule.
 *
 * Supported trigger types:
 *  - cron:     cronExpression + timezone (IANA)
 *  - interval: intervalSeconds (fires every N seconds)
 *  - once:     executeAt (one-shot at a specific UTC timestamp)
 */
const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** The internal agent that will be invoked when the trigger fires */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),

    /** Organization owning this trigger */
    organizationId: text("organization_id").notNull(),

    /** Human-readable name for the trigger (e.g., "Daily morning report") */
    name: text("name").notNull(),

    /** Trigger scheduling strategy */
    triggerType: text("trigger_type")
      .$type<TriggerType>()
      .notNull()
      .default("cron"),

    // --- Scheduling config (only one is set depending on triggerType) ---

    /** Standard cron expression (e.g., "0 9 * * MON") \u2014 used when triggerType='cron' */
    cronExpression: text("cron_expression"),

    /** Seconds between executions \u2014 used when triggerType='interval' */
    intervalSeconds: integer("interval_seconds"),

    /** Exact timestamp to fire \u2014 used when triggerType='once' */
    executeAt: timestamp("execute_at", { mode: "date" }),

    /** IANA timezone string (e.g., "America/New_York"). Defaults to UTC. */
    timezone: text("timezone").notNull().default("UTC"),

    // --- Execution config ---

    /** The message text delivered to the agent on each trigger invocation */
    inputMessage: text("input_message").notNull(),

    /** Whether this trigger is currently active and should be scheduled */
    enabled: boolean("enabled").notNull().default(true),

    /**
     * Maximum number of seconds past the scheduled time that a trigger may
     * still fire. Executions beyond this window are skipped (misfired).
     */
    misfireGraceSeconds: integer("misfire_grace_seconds")
      .notNull()
      .default(60),

    // --- Execution tracking ---

    /** Timestamp of the most recent successful or failed execution */
    lastExecutedAt: timestamp("last_executed_at", { mode: "date" }),

    /** Computed next scheduled execution time (updated after each run) */
    nextExecuteAt: timestamp("next_execute_at", { mode: "date" }),

    /** Outcome of the most recent execution */
    lastStatus: text("last_status").$type<TriggerStatus>(),

    /** Error message from the most recent failed execution */
    lastError: text("last_error"),

    /** Total number of times this trigger has been executed */
    executionCount: integer("execution_count").notNull().default(0),

    // --- Audit ---

    /** User ID of the person who created the trigger */
    createdBy: text("created_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),

    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_schedule_triggers_agent_id_idx").on(table.agentId),
    index("agent_schedule_triggers_organization_id_idx").on(
      table.organizationId,
    ),
    index("agent_schedule_triggers_enabled_next_execute_at_idx").on(
      table.enabled,
      table.nextExecuteAt,
    ),
  ],
);

export default agentScheduleTriggersTable;
