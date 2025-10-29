import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
});
export const InsertMcpServerSchema = createInsertSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
});
export const UpdateMcpServerSchema = createUpdateSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
});

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
