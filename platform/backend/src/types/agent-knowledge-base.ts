import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentKnowledgeBaseSchema = createSelectSchema(
  schema.agentKnowledgeBasesTable,
);
export const InsertAgentKnowledgeBaseSchema = createInsertSchema(
  schema.agentKnowledgeBasesTable,
).omit({ createdAt: true });

export type AgentKnowledgeBase = z.infer<typeof SelectAgentKnowledgeBaseSchema>;
export type InsertAgentKnowledgeBase = z.infer<
  typeof InsertAgentKnowledgeBaseSchema
>;
