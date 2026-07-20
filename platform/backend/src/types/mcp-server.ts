import { LOCAL_MCP_INSTALLATION_STATES } from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { InternalMcpCatalogServerTypeSchema } from "./mcp-catalog";
import { ResourceVisibilityScopeSchema } from "./visibility";

export const LocalMcpServerInstallationStatusSchema = z.enum(
  LOCAL_MCP_INSTALLATION_STATES,
);

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
  scope: ResourceVisibilityScopeSchema,
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
  /**
   * Agents (profiles / MCP gateways) with tools explicitly assigned from this
   * server — statically pinned to it, or unpinned on a tool of its catalog.
   */
  assignedAgents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
  /**
   * Auto-mode agents (implicit access to all tools) in this server's
   * organization. They reach every server without an explicit tool assignment,
   * so they are listed separately from `assignedAgents` — the same org-wide set
   * appears on every server.
   */
  autoModeAgents: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
      }),
    )
    .optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
  secretStorageType: SecretStorageTypeSchema.optional(),
});

export const InsertMcpServerSchema = createInsertSchema(schema.mcpServersTable)
  .extend({
    serverType: InternalMcpCatalogServerTypeSchema,
    scope: ResourceVisibilityScopeSchema.optional(),
    userId: z.string().optional(), // For personal auth
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
    userConfigValues: z.record(z.string(), z.string()).optional(),
    environmentValues: z.record(z.string(), z.string()).optional(),
  })
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    // Frozen K8s deployment identity — computed by McpServerModel.create /
    // the startup adopt pass, never accepted from input.
    deploymentName: true,
    // Server-owned OAuth refresh-failure state, written only by the refresh
    // subsystem (routes/oauth.ts) — a freshly installed server has never
    // attempted a refresh, and accepting these from install input would let
    // a caller seed arbitrary (including unsanitized) diagnostic text shown
    // to other users with access to the install.
    oauthRefreshError: true,
    oauthRefreshErrorMessage: true,
    oauthRefreshErrorDescription: true,
    oauthRefreshFailedAt: true,
  });

export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable)
  .omit({
    serverType: true, // serverType should not be updated after creation
    scope: true, // scope is install-time only; to change scope, uninstall + reinstall
    // Frozen at creation/adopt time — renames must never touch it
    deploymentName: true,
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
