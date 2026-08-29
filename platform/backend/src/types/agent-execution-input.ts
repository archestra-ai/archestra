import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentExecutionInputSchema = createSelectSchema(
  schema.agentExecutionInputsTable,
);
export const InsertAgentExecutionInputSchema = createInsertSchema(
  schema.agentExecutionInputsTable,
).omit({ id: true, createdAt: true });

export type AgentExecutionInput = z.infer<
  typeof SelectAgentExecutionInputSchema
>;
export type InsertAgentExecutionInput = z.infer<
  typeof InsertAgentExecutionInputSchema
>;
