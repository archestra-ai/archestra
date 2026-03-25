import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectAgentScheduleTriggerSchema = createSelectSchema(
  schema.agentScheduleTriggersTable,
);

export const InsertAgentScheduleTriggerSchema = createInsertSchema(
  schema.agentScheduleTriggersTable,
  {
    enabled: z.boolean().default(true),
  },
).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastRunAt: true,
  nextRunAt: true,
  consecutiveFailures: true,
});

export const UpdateAgentScheduleTriggerSchema = createUpdateSchema(
  schema.agentScheduleTriggersTable,
).pick({
  name: true,
  description: true,
  schedule: true,
  message: true,
  payload: true,
  enabled: true,
  timezone: true,
});

export type AgentScheduleTrigger = z.infer<
  typeof SelectAgentScheduleTriggerSchema
>;
export type InsertAgentScheduleTrigger = z.infer<
  typeof InsertAgentScheduleTriggerSchema
>;
export type UpdateAgentScheduleTrigger = z.infer<
  typeof UpdateAgentScheduleTriggerSchema
>;
