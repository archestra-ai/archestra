import type { schema } from "@/database";

export type AgentSchedule = typeof schema.agentSchedulesTable.$inferSelect;
export type InsertAgentSchedule = typeof schema.agentSchedulesTable.$inferInsert;
export type UpdateAgentSchedule = Partial<InsertAgentSchedule>;
