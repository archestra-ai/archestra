import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectAgentScheduleSchema = createSelectSchema(schema.agentSchedulesTable);
export const InsertAgentScheduleSchema = createInsertSchema(schema.agentSchedulesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const UpdateAgentScheduleSchema = createUpdateSchema(schema.agentSchedulesTable).omit({
  id: true,
  createdAt: true,
  agentId: true,
});

export type AgentSchedule = z.infer<typeof SelectAgentScheduleSchema>;
export type InsertAgentSchedule = z.infer<typeof InsertAgentScheduleSchema>;
export type UpdateAgentSchedule = z.infer<typeof UpdateAgentScheduleSchema>;
