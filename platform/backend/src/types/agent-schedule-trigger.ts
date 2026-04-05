import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const AgentScheduleOverlapPolicySchema = z.enum([
  "skip",
  "allow_all",
  "buffer_one",
]);
export type AgentScheduleOverlapPolicy = z.infer<
  typeof AgentScheduleOverlapPolicySchema
>;

export const AgentScheduleStatusSchema = z.enum(["active", "paused"]);
export type AgentScheduleStatus = z.infer<typeof AgentScheduleStatusSchema>;

export const AgentScheduleRunStatusSchema = z.enum([
  "success",
  "failure",
  "running",
]);
export type AgentScheduleRunStatus = z.infer<
  typeof AgentScheduleRunStatusSchema
>;

export const SelectAgentScheduleTriggerSchema = createSelectSchema(
  schema.agentScheduleTriggersTable,
  {
    overlapPolicy: AgentScheduleOverlapPolicySchema,
    status: AgentScheduleStatusSchema,
  },
);
export type AgentScheduleTrigger = z.infer<
  typeof SelectAgentScheduleTriggerSchema
>;

export const InsertAgentScheduleTriggerSchema = createInsertSchema(
  schema.agentScheduleTriggersTable,
  {
    overlapPolicy: AgentScheduleOverlapPolicySchema,
    status: AgentScheduleStatusSchema.optional(),
  },
).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertAgentScheduleTrigger = z.infer<
  typeof InsertAgentScheduleTriggerSchema
>;

export const SelectAgentScheduleRunSchema = createSelectSchema(
  schema.agentScheduleRunsTable,
  {
    status: AgentScheduleRunStatusSchema,
  },
);
export type AgentScheduleRun = z.infer<typeof SelectAgentScheduleRunSchema>;

export const InsertAgentScheduleRunSchema = createInsertSchema(
  schema.agentScheduleRunsTable,
  {
    status: AgentScheduleRunStatusSchema.optional(),
  },
).omit({ id: true });
export type InsertAgentScheduleRun = z.infer<
  typeof InsertAgentScheduleRunSchema
>;
