import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentConnectorAssignmentSchema = createSelectSchema(
  schema.agentConnectorAssignmentsTable,
);
export const InsertAgentConnectorAssignmentSchema = createInsertSchema(
  schema.agentConnectorAssignmentsTable,
).omit({ createdAt: true });

export type AgentConnectorAssignment = z.infer<
  typeof SelectAgentConnectorAssignmentSchema
>;
export type InsertAgentConnectorAssignment = z.infer<
  typeof InsertAgentConnectorAssignmentSchema
>;
