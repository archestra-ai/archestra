import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectAgentToolSchema = createSelectSchema(schema.agentToolsTable);
export const InsertAgentToolSchema = createInsertSchema(schema.agentToolsTable);
export const UpdateAgentToolSchema = createUpdateSchema(schema.agentToolsTable);

export type AgentTool = z.infer<typeof SelectAgentToolSchema>;
export type InsertAgentTool = z.infer<typeof InsertAgentToolSchema>;
export type UpdateAgentTool = z.infer<typeof UpdateAgentToolSchema>;
