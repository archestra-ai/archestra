import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectAgentScheduleTriggerSchema = createSelectSchema(
  schema.agentScheduleTriggersTable,
);

export const InsertAgentScheduleTriggerSchema = createInsertSchema(
  schema.agentScheduleTriggersTable,
).omit({
  id: true,
  lastExecutedAt: true,
  nextExecuteAt: true,
  lastStatus: true,
  lastError: true,
  executionCount: true,
  createdAt: true,
  updatedAt: true,
});

export type SelectAgentScheduleTrigger = z.infer<
  typeof SelectAgentScheduleTriggerSchema
>;
export type InsertAgentScheduleTrigger = z.infer<
  typeof InsertAgentScheduleTriggerSchema
>;

export type TriggerType = "cron" | "interval" | "once";
export type TriggerStatus = "success" | "error";
