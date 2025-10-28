import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

const McpServerInstallationRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "declined",
]);

const McpServerInstallationRequestNoteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const SelectMcpServerInstallationRequestSchema = createSelectSchema(
  schema.mcpServerInstallationRequestTable,
).extend({
  notes: z.array(McpServerInstallationRequestNoteSchema).nullable(),
});

export const InsertMcpServerInstallationRequestSchema = createInsertSchema(
  schema.mcpServerInstallationRequestTable,
).extend({
  notes: z.array(McpServerInstallationRequestNoteSchema).nullable().optional(),
  status: McpServerInstallationRequestStatusSchema.optional(),
});

export const UpdateMcpServerInstallationRequestSchema = createUpdateSchema(
  schema.mcpServerInstallationRequestTable,
).extend({
  notes: z.array(McpServerInstallationRequestNoteSchema).nullable().optional(),
  status: McpServerInstallationRequestStatusSchema.optional(),
});

export type McpServerInstallationRequestStatus = z.infer<
  typeof McpServerInstallationRequestStatusSchema
>;
export type McpServerInstallationRequestNote = z.infer<
  typeof McpServerInstallationRequestNoteSchema
>;

export type McpServerInstallationRequest = z.infer<
  typeof SelectMcpServerInstallationRequestSchema
>;
export type InsertMcpServerInstallationRequest = z.infer<
  typeof InsertMcpServerInstallationRequestSchema
>;
export type UpdateMcpServerInstallationRequest = z.infer<
  typeof UpdateMcpServerInstallationRequestSchema
>;
