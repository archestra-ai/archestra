import { sql } from "drizzle-orm";
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
import type { AgentScheduleTriggerType } from "@/types";
import agentsTable from "./agent";

export const agentScheduleTriggerTypeEnum = pgEnum(
  "agent_schedule_trigger_type",
  ["cron", "interval", "one_time"],
);

const agentScheduleTriggersTable = pgTable(
  "agent_schedule_triggers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agentsTable.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    triggerType: agentScheduleTriggerTypeEnum("trigger_type")
      .$type<AgentScheduleTriggerType>()
      .notNull(),
    enabled: boolean("enabled").notNull().default(true),
    cronExpression: text("cron_expression"),
    intervalSeconds: integer("interval_seconds"),
    scheduledAt: timestamp("scheduled_at", { mode: "date" }),
    message: text("message").notNull().default(""),
    lastExecutedAt: timestamp("last_executed_at", { mode: "date" }),
    nextExecutionAt: timestamp("next_execution_at", { mode: "date" }),
    executionCount: integer("execution_count").notNull().default(0),
    lastError: text("last_error"),
    misfireGraceSeconds: integer("misfire_grace_seconds")
      .notNull()
      .default(300),
    createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("agent_schedule_triggers_agent_id_idx").on(table.agentId),
    index("agent_schedule_triggers_enabled_idx")
      .on(table.enabled, table.nextExecutionAt)
      .where(sql`${table.enabled} = true`),
    index("agent_schedule_triggers_org_idx").on(table.organizationId),
  ],
);

export default agentScheduleTriggersTable;
