import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ScheduleTriggerType } from "@/types/agent-schedule-trigger";

import agentsTable from "./agent";
import usersTable from "./user";

export const scheduleTriggerTypeEnum = pgEnum("schedule_trigger_type", [
  "cron",
  "interval",
  "once",
]);

const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    triggerType: scheduleTriggerTypeEnum("trigger_type")
      .$type<ScheduleTriggerType>()
      .notNull(),
    cronExpression: text("cron_expression"),
    intervalSeconds: integer("interval_seconds"),
    executeAt: timestamp("execute_at", { mode: "date", withTimezone: true }),
    timezone: text("timezone").notNull().default("UTC"),
    inputMessage: text("input_message").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    misfireGraceSeconds: integer("misfire_grace_seconds")
      .notNull()
      .default(60),
    lastExecutedAt: timestamp("last_executed_at", {
      mode: "date",
      withTimezone: true,
    }),
    nextExecuteAt: timestamp("next_execute_at", {
      mode: "date",
      withTimezone: true,
    }),
    lastStatus: text("last_status"),
    lastError: text("last_error"),
    executionCount: integer("execution_count").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "set null" }),
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
    index("agent_schedule_triggers_enabled_idx").on(table.enabled),
  ],
);

export default agentScheduleTriggersTable;
