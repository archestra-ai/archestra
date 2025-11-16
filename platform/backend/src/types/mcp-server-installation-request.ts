import { LocalConfigSchema, OAuthConfigSchema } from "@shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const McpServerInstallationRequestStatusSchema = z.enum([
  "pending",
  "approved",
  "declined",
]);

const RemoteCustomServerConfigSchema = z.object({
  type: z.literal("remote"),
  label: z.string(),
  name: z.string(),
  version: z.string().optional(),
  serverType: z.string(),
  serverUrl: z.string().optional(),
  docsUrl: z.string().optional(),
  userConfig: z.record(z.string(), z.any()).optional(),
  oauthConfig: OAuthConfigSchema.optional(),
});

const LocalCustomServerConfigSchema = z.object({
  type: z.literal("local"),
  label: z.string(),
  name: z.string(),
  version: z.string().optional(),
  serverType: z.literal("local"),
  localConfig: LocalConfigSchema,
});

export const McpServerInstallationRequestCustomServerConfigSchema = z
  .discriminatedUnion("type", [
    RemoteCustomServerConfigSchema,
    LocalCustomServerConfigSchema,
  ])
  .nullable();

const McpServerInstallationRequestNoteSchema = z.object({
  id: z.string(),
  userId: z.string(),
  userName: z.string(),
  content: z.string(),
  createdAt: z.string(),
});

export const SelectMcpServerInstallationRequestSchema = createSelectSchema(
  schema.mcpServerInstallationRequestsTable,
).extend({
  notes: z.array(McpServerInstallationRequestNoteSchema).nullable(),
  customServerConfig: McpServerInstallationRequestCustomServerConfigSchema,
});

export const InsertMcpServerInstallationRequestSchema = createInsertSchema(
  schema.mcpServerInstallationRequestsTable,
)
  .extend({
    notes: z
      .array(McpServerInstallationRequestNoteSchema)
      .nullable()
      .optional(),
    status: McpServerInstallationRequestStatusSchema.optional(),
    customServerConfig: McpServerInstallationRequestCustomServerConfigSchema,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    requestedBy: true,
    status: true,
    reviewedBy: true,
    reviewedAt: true,
    adminResponse: true,
    notes: true,
  });

export const UpdateMcpServerInstallationRequestSchema = createUpdateSchema(
  schema.mcpServerInstallationRequestsTable,
)
  .extend({
    notes: z
      .array(McpServerInstallationRequestNoteSchema)
      .nullable()
      .optional(),
    status: McpServerInstallationRequestStatusSchema.optional(),
    customServerConfig: McpServerInstallationRequestCustomServerConfigSchema,
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    externalCatalogId: true,
    requestedBy: true,
  });

export type McpServerInstallationRequestStatus = z.infer<
  typeof McpServerInstallationRequestStatusSchema
>;
export type McpServerInstallationRequestNote = z.infer<
  typeof McpServerInstallationRequestNoteSchema
>;
export type McpServerInstallationRequestCustomServerConfig = z.infer<
  typeof McpServerInstallationRequestCustomServerConfigSchema
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
