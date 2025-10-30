import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const LocalMcpServerInstallationStatusSchema = z.enum([
  "idle",
  "pending",
  "success",
  "error",
]);

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
});
export const InsertMcpServerSchema = createInsertSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
});
export const UpdateMcpServerSchema = createUpdateSchema(
  schema.mcpServersTable,
).extend({
  teams: z.array(z.string()).optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
});

export type LocalMcpServerInstallationStatus = z.infer<
  typeof LocalMcpServerInstallationStatusSchema
>;

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
