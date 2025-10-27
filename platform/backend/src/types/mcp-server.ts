import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

/**
 * NOTE: for right now metadata is just being used to store GitHub credentials for demo purposes..
 * we may not need this in the future and if that is the case, we should remove the column...
 */
const McpServerMetadataSchema = z.record(z.string(), z.unknown());

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
  {
    metadata: McpServerMetadataSchema,
  },
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

export type McpServerMetadata = z.infer<typeof McpServerMetadataSchema>;
