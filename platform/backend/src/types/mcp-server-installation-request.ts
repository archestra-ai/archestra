import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

// Define Zod schema for notes JSONB field
const NoteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const SelectMcpServerInstallationRequestSchema = createSelectSchema(
  schema.mcpServerInstallationRequestTable
).extend({
  notes: z.array(NoteSchema).nullable(),
});

export const InsertMcpServerInstallationRequestSchema = createInsertSchema(
  schema.mcpServerInstallationRequestTable
).extend({
  notes: z.array(NoteSchema).nullable().optional(),
  status: z.enum(["pending", "approved", "declined"]).optional(),
});

export const UpdateMcpServerInstallationRequestSchema = createUpdateSchema(
  schema.mcpServerInstallationRequestTable
).extend({
  notes: z.array(NoteSchema).nullable().optional(),
  status: z.enum(["pending", "approved", "declined"]).optional(),
});

export type McpServerInstallationRequest = z.infer<
  typeof SelectMcpServerInstallationRequestSchema
>;
export type InsertMcpServerInstallationRequest = z.infer<
  typeof InsertMcpServerInstallationRequestSchema
>;
export type UpdateMcpServerInstallationRequest = z.infer<
  typeof UpdateMcpServerInstallationRequestSchema
>;
