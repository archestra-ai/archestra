import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import type { z } from "zod";
import { schema } from "@/database";

export const SelectMcpServerSchema = createSelectSchema(schema.mcpServersTable);
export const InsertMcpServerSchema = createInsertSchema(schema.mcpServersTable);
export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable);

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
