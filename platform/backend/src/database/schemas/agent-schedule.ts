import { boolean, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { Cron } from "croner";
import agentsTable from "./agent";

/**
 * Agent schedule triggers table.
 *
 * Each row represents a recurring cron-based trigger for an agent.
 * The scheduler polls this table every minute and enqueues an
 * `agent_schedule_run` task when a cron expression is due.
 *
 * Design decisions:
 * - Standalone table (no changes to agents table) → zero breaking changes
 * - CASCADE DELETE: schedules are owned by the agent
 * - `lastRunAt` mirrors the connector pattern for due-date calculation
 * - `cron` is validated on insert via the `Cron` constructor (croner)
 */
const agentSchedulesTable = pgTable(
  "agent_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    /** FK to the agent that owns this schedule */
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),

    /**
     * Standard 5-field cron expression (e.g. "0 9 * * 1" = every Monday at 9am).
     * Validated by croner before persistence.
     */
    cron: text("cron").notNull(),

    /**
     * Message content injected as the user turn when the schedule fires.
     * Kept here so the scheduler is self-contained and needs no extra context.
     */
    message: text("message").notNull(),

    /** When false, the scheduler skips this row entirely. */
    enabled: boolean("enabled").notNull().default(true),

    /** Timestamp of the last successful trigger; null means never ran. */
    lastRunAt: timestamp("last_run_at", { withTimezone: true, mode: "date" }),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),

    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    index("agent_schedules_agent_id_idx").on(table.agentId),
    index("agent_schedules_enabled_idx").on(table.enabled),
  ],
);

export default agentSchedulesTable;

/**
 * Validates a cron expression string using croner.
 * Throws a descriptive error if invalid — call this before persisting.
 */
export function validateCronExpression(cron: string): void {
  try {
    // Cron constructor throws if the expression is invalid
    new Cron(cron);
  } catch {
    throw new Error(
      `Invalid cron expression: "${cron}". ` +
        `Must be a valid 5-field cron (e.g. "0 9 * * 1" for Monday at 9am).`,
    );
  }
}
