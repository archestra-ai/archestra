import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectMcpServerInstallationRequestSchema = createSelectSchema(
  schema.mcpServerInstallationRequestTable,
);

export const InsertMcpServerInstallationRequestSchema = createInsertSchema(
  schema.mcpServerInstallationRequestTable,
);

export const UpdateMcpServerInstallationRequestSchema = createUpdateSchema(
  schema.mcpServerInstallationRequestTable,
);

export type McpServerInstallationRequest = z.infer<
  typeof SelectMcpServerInstallationRequestSchema
>;
export type InsertMcpServerInstallationRequest = z.infer<
  typeof InsertMcpServerInstallationRequestSchema
>;
export type UpdateMcpServerInstallationRequest = z.infer<
  typeof UpdateMcpServerInstallationRequestSchema
>;
