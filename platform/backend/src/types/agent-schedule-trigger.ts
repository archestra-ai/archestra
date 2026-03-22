import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { agentScheduleTriggerRunsTable } from "../schedule-triggers/models/agent-schedule-trigger-run";
import { agentScheduleTriggersTable } from "../schedule-triggers/models/agent-schedule-trigger";

// --- Agent Schedule Trigger ---
export const SelectAgentScheduleTriggerSchema = createSelectSchema(agentScheduleTriggersTable);
export const InsertAgentScheduleTriggerSchema = createInsertSchema(agentScheduleTriggersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateAgentScheduleTriggerSchema = createUpdateSchema(agentScheduleTriggersTable).omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
});

export type AgentScheduleTrigger = z.infer<typeof SelectAgentScheduleTriggerSchema>;
export type InsertAgentScheduleTrigger = z.infer<typeof InsertAgentScheduleTriggerSchema>;
export type UpdateAgentScheduleTrigger = z.infer<typeof UpdateAgentScheduleTriggerSchema>;

// --- Agent Schedule Trigger Run ---
export const SelectAgentScheduleTriggerRunSchema = createSelectSchema(agentScheduleTriggerRunsTable);
export const InsertAgentScheduleTriggerRunSchema = createInsertSchema(agentScheduleTriggerRunsTable).omit({
  id: true,
  createdAt: true,
});

export type AgentScheduleTriggerRun = z.infer<typeof SelectAgentScheduleTriggerRunSchema>;
export type InsertAgentScheduleTriggerRun = z.infer<typeof InsertAgentScheduleTriggerRunSchema>;
