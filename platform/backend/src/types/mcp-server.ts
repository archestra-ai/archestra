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

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  ownerEmail: z.string().nullable().optional(),
  teams: z.array(z.string()).optional(),
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
    .array(
      z.object({
        teamId: z.string(),
        name: z.string(),
        createdAt: z.coerce.date(),
      }),
    )
    .optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
});
export const InsertMcpServerSchema = createInsertSchema(
  schema.mcpServersTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  teams: z.array(z.string()).optional(),
  userId: z.string().optional(), // For personal auth
  localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
  userConfigValues: z.record(z.string(), z.string()).optional(),
  environmentValues: z.record(z.string(), z.string()).optional(),
});
export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable)
  .omit({
    serverType: true, // serverType should not be updated after creation
  })
  .extend({
    teams: z.array(z.string()).optional(),
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
  });

export type LocalMcpServerInstallationStatus = z.infer<
  typeof LocalMcpServerInstallationStatusSchema
>;

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
