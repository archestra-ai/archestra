import { LOCAL_MCP_INSTALLATION_STATES } from "@archestra/shared";
import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";
import { AgentTypeSchema } from "./agent";
import { InternalMcpCatalogServerTypeSchema } from "./mcp-catalog";
import { ResourceVisibilityScopeSchema } from "./visibility";

/**
 * An agent (chat agent, MCP gateway, LLM proxy) that can reach an MCP server,
 * as surfaced on the registry card's "used by" tooltip and the server's Usage
 * tab.
 *
 * Personal agents are auto-seeded one per member and every member's copy
 * carries the same name ("My Assistant", "My Gateway"), so a bare name list
 * reads as duplicates. `scope` and `ownerEmail` are carried alongside so the
 * UI can attribute each one to its owner. `ownerEmail` is null when the author
 * has been deleted (the FK nulls out) or for agents with no author.
 */
export const McpServerAgentUsageSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentType: AgentTypeSchema,
  scope: ResourceVisibilityScopeSchema,
  ownerEmail: z.string().nullable(),
});

export type McpServerAgentUsage = z.infer<typeof McpServerAgentUsageSchema>;

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

/**
 * Why a pending reinstall was flagged, persisted alongside
 * `reinstallRequired`. "new-input": the catalog's prompted schema changed —
 * the user owes values the install doesn't have, so the UI must collect
 * them. "restart": stored values are still valid (execution-config change,
 * retry after a failed sync) — an empty-body reinstall reusing the stored
 * bag suffices. Null whenever `reinstallRequired` is false.
 */
export const McpServerReinstallReasonSchema = z.enum(["new-input", "restart"]);

export type McpServerReinstallReason = z.infer<
  typeof McpServerReinstallReasonSchema
>;

export {
  type McpServerHibernationMode,
  McpServerHibernationModeSchema,
} from "./mcp-hibernation";

import { McpServerHibernationModeSchema } from "./mcp-hibernation";

export const SelectMcpServerSchema = createSelectSchema(
  schema.mcpServersTable,
).extend({
  serverType: InternalMcpCatalogServerTypeSchema,
  scope: ResourceVisibilityScopeSchema,
  reinstallReason: McpServerReinstallReasonSchema.nullable(),
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
  assignedAgents: z.array(McpServerAgentUsageSchema).optional(),
  /**
   * Auto-mode agents (implicit access to all tools) in this server's
   * organization. They reach every server without an explicit tool assignment,
   * so they are listed separately from `assignedAgents` — the same org-wide set
   * appears on every server.
   */
  autoModeAgents: z.array(McpServerAgentUsageSchema).optional(),
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
  secretStorageType: SecretStorageTypeSchema.optional(),
  hibernationMode: McpServerHibernationModeSchema,
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
    // Soft-delete bookkeeping, written only by delete/restore, never from input.
    deletedAt: true,
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
    // Server-owned reinstall bookkeeping — a fresh install is never flagged.
    reinstallReason: true,
    // Server-owned idle-hibernation bookkeeping, written only via
    // McpServerModel.updateLastUsed — accepting it from input would let a
    // caller exempt a server (and its multitenant siblings) from hibernation.
    lastUsedAt: true,
    // Enterprise-gated, so it is set through the (licence-checking) update
    // route rather than smuggled in at install time. A fresh install inherits
    // the organization's toggle.
    hibernationMode: true,
  });

export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable)
  .omit({
    serverType: true, // serverType should not be updated after creation
    scope: true, // scope is install-time only; to change scope, uninstall + reinstall
    // Frozen at creation/adopt time — renames must never touch it
    deploymentName: true,
    // Soft-delete bookkeeping, written only by delete/restore, never from input.
    deletedAt: true,
    // Server-owned idle-hibernation bookkeeping, never from input.
    lastUsedAt: true,
  })
  .extend({
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
    reinstallReason: McpServerReinstallReasonSchema.nullable().optional(),
    // Settable: the enterprise licence check lives on the route that accepts it.
    hibernationMode: McpServerHibernationModeSchema.optional(),
  });

export type LocalMcpServerInstallationStatus = z.infer<
  typeof LocalMcpServerInstallationStatusSchema
>;

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
