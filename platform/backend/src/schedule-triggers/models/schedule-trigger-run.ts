import { pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { scheduleTriggersTable } from "./schedule-trigger";

export const scheduleTriggerRunsTable = pgTable(
  "schedule_trigger_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    triggerId: uuid("trigger_id")
      .notNull()
      .references(() => scheduleTriggersTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    runKind: text("run_kind").notNull(), // "scheduled" | "manual"
    status: text("status").notNull().default("pending"), // "pending" | "running" | "success" | "failed"
    dueAt: timestamp("due_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    error: text("error"),
    agentIdSnapshot: text("agent_id_snapshot").notNull(),
    messageTemplateSnapshot: text("message_template_snapshot").notNull(),
    actorUserIdSnapshot: text("actor_user_id_snapshot").notNull(),
    cronExpressionSnapshot: text("cron_expression_snapshot"),
    timezoneSnapshot: text("timezone_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => {
    return {
      uniqueTriggerDueAt: unique("uq_trigger_id_due_at").on(
        table.triggerId,
        table.dueAt,
      ),
    };
  },
);

export type ScheduleTriggerRun = typeof scheduleTriggerRunsTable.$inferSelect;
export type InsertScheduleTriggerRun =
  typeof scheduleTriggerRunsTable.$inferInsert;
