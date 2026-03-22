import {
  boolean,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

export const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    messageTemplate: text("message_template").notNull(),
    scheduleKind: text("schedule_kind").notNull().default("cron"),
    cronExpression: text("cron_expression").notNull(),
    timezone: text("timezone").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    actorUserId: text("actor_user_id").notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => {
    return {
      enabledNextDueAtIndex: index("idx_agent_schedule_triggers_enabled_next_due_at").on(
        table.enabled,
        table.nextDueAt,
      ),
    };
  },
);

export type AgentScheduleTrigger = typeof agentScheduleTriggersTable.$inferSelect;
export type InsertAgentScheduleTrigger = typeof agentScheduleTriggersTable.$inferInsert;
