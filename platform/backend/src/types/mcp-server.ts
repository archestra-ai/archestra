import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectMcpServerSchema = createSelectSchema(schema.mcpServerTable);
export const InsertMcpServerSchema = createInsertSchema(schema.mcpServerTable);
export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServerTable);

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
