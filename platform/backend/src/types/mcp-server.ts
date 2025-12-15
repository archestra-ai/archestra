import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { InternalMcpCatalogServerTypeSchema } from "./mcp-catalog";

export const LocalMcpServerInstallationStatusSchema = z.enum([
  "idle",
  "pending",
  "discovering-tools",
  "success",
  "error",
]);

export const SecretStorageTypeSchema = z.enum([
  "vault",
  "external_vault",
  "database",
  "none",
]);

export type SecretStorageType = z.infer<typeof SecretStorageTypeSchema>;

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  ownerEmail: z.string().nullable().optional(),
  catalogName: z.string().nullable().optional(),
  users: z.array(z.string()).optional(),
  userDetails: z
    .array(
      z.object({
        userId: z.string(),
        email: z.string(),
        createdAt: z.coerce.date(),
      }),
    )
    .optional(),
  teamDetails: z
    .object({
      teamId: z.string(),
      name: z.string(),
      createdAt: z.coerce.date(),
    })
    .nullable()
    .optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
  secretStorageType: SecretStorageTypeSchema.optional(),
});

export const InsertMcpServerSchema = createInsertSchema(schema.mcpServersTable)
  .extend({
    serverType: InternalMcpCatalogServerTypeSchema,
    userId: z.string().optional(), // For personal auth
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
    userConfigValues: z.record(z.string(), z.string()).optional(),
    environmentValues: z.record(z.string(), z.string()).optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
  });

export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable)
  .omit({
    serverType: true, // serverType should not be updated after creation
  })
  .extend({
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
  });

export type LocalMcpServerInstallationStatus = z.infer<
  typeof LocalMcpServerInstallationStatusSchema
>;

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
