import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentRunInputSchema = createSelectSchema(
  schema.agentRunInputsTable,
);
export const InsertAgentRunInputSchema = createInsertSchema(
  schema.agentRunInputsTable,
).omit({ id: true, createdAt: true });

export type AgentRunInput = z.infer<typeof SelectAgentRunInputSchema>;
export type InsertAgentRunInput = z.infer<typeof InsertAgentRunInputSchema>;
