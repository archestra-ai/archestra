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
import { McpServerAlertMuteSchema } from "./mcp-server-alert-mute";
import { ResourceVisibilityScopeSchema } from "./visibility";

/**
 * An agent (chat agent, MCP gateway, LLM proxy) that can reach an MCP server,
 * as surfaced on the registry card's "used by" tooltip and the server's Usage
 * tab.
 *
 * Personal agents are auto-seeded one per member and every member's copy
 * carries the same name ("My Assistant", "My Gateway"), so a bare name list
 * reads as duplicates. `scope`, `ownerId` and `ownerEmail` are carried
 * alongside so the UI can attribute each one to its owner.
 *
 * Both owner fields are null together when the agent has no author, and for a
 * PERSONAL agent that means one thing: the author's account was deleted. The
 * FK is `ON DELETE SET NULL` and users are hard-deleted, so the agent outlives
 * the person. Every create path stamps an author, and both routes that could
 * make an existing agent personal refuse to do so without one, so there is no
 * other way into that state — a consumer may say "deleted", not "unknown".
 *
 * Who they were is NOT recoverable, here or anywhere: sixteen tables lose a
 * user identity the same way. Retaining it belongs in user deletion, not in a
 * column per table — see the PR discussion.
 *
 * A surface that names an owner has to distinguish these cases rather than
 * fall back to the scope, which is how the Usage tab came to print the word
 * "Personal" where an owner belongs.
 *
 * `ownerId` is what identifies the viewer's own agents: matching on the email
 * would compare a display string, and it is absent on exactly the rows that
 * most need telling apart.
 */
export const McpServerAgentUsageSchema = z.object({
  id: z.string(),
  name: z.string(),
  agentType: AgentTypeSchema,
  scope: ResourceVisibilityScopeSchema,
  /**
   * The AGENT's author — `agents.author_id`. Not to be confused with
   * `SelectMcpServerSchema.ownerEmail` further down this file, which is the
   * person who installed the SERVER (`mcp_server.owner_id`): the two live in
   * the same file and mean different people. Named for the pre-existing
   * `ownerEmail` it sits beside rather than for the column, so the pair stays
   * consistent; renaming both to `author*` is worth doing, but it reaches
   * `ToolDelegationTarget` too and belongs in its own change.
   */
  ownerId: z.string().nullable(),
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

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
export {
  type McpServerHibernationMode,
  McpServerHibernationModeSchema,
} from "./mcp-hibernation";

import { McpServerHibernationModeSchema } from "./mcp-hibernation";
// SPDX-SnippetEnd

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
  localInstallationStatus: LocalMcpServerInstallationStatusSchema,
  secretStorageType: SecretStorageTypeSchema.optional(),
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  hibernationMode: McpServerHibernationModeSchema,
  // SPDX-SnippetEnd
});

/**
 * A row of the MCP server listing: the install plus the CALLER's own alert
 * mutes that still apply to it, so the registry can render a silenced alert
 * without a second round trip. Never another viewer's — a mute hides an alert
 * for one person only.
 *
 * Separate from `SelectMcpServerSchema` because the listing is the only route
 * that resolves mutes: every other route answers with the bare install, and
 * `McpServer` (the model row type) has no mutes on it at all. Keeping them here
 * lets the field be required, so a client never has to distinguish "no mutes"
 * from "this response did not compute them".
 */
export const McpServerListEntrySchema = SelectMcpServerSchema.extend({
  alertMutes: z.array(McpServerAlertMuteSchema),
  /**
   * Whether the CALLER may present this install's stored credential to the
   * upstream — their own connection, or one shared with them. False for
   * another member's personal connection, which the listing still returns to
   * installation admins so they can manage it. Surfaces that authenticate as
   * the install (the Inspector) offer only the connections this is true for.
   */
  canUseCredential: z
    .boolean()
    .describe(
      "Whether the caller may present this install's stored credential to the upstream — their own connection, or one shared with them. False for another member's personal connection, which the listing still returns to installation admins so they can manage it.",
    ),
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
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Server-owned idle-hibernation bookkeeping, written only via
    // McpServerModel.updateLastUsed — accepting it from input would let a
    // caller exempt a server (and its multitenant siblings) from hibernation.
    lastUsedAt: true,
    // Enterprise-gated, so it is set through the (licence-checking) update
    // route rather than smuggled in at install time. A fresh install inherits
    // the organization's toggle.
    hibernationMode: true,
    // SPDX-SnippetEnd
  });

export const UpdateMcpServerSchema = createUpdateSchema(schema.mcpServersTable)
  .omit({
    serverType: true, // serverType should not be updated after creation
    scope: true, // scope is install-time only; to change scope, uninstall + reinstall
    // Frozen at creation/adopt time — renames must never touch it
    deploymentName: true,
    // Soft-delete bookkeeping, written only by delete/restore, never from input.
    deletedAt: true,
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Server-owned idle-hibernation bookkeeping, never from input.
    lastUsedAt: true,
    // SPDX-SnippetEnd
  })
  .extend({
    localInstallationStatus: LocalMcpServerInstallationStatusSchema.optional(),
    reinstallReason: McpServerReinstallReasonSchema.nullable().optional(),
    // SPDX-SnippetBegin
    // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
    // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
    // Settable: the enterprise licence check lives on the route that accepts it.
    hibernationMode: McpServerHibernationModeSchema.optional(),
    // SPDX-SnippetEnd
  });

export type LocalMcpServerInstallationStatus = z.infer<
  typeof LocalMcpServerInstallationStatusSchema
>;

export type McpServer = z.infer<typeof SelectMcpServerSchema>;
export type InsertMcpServer = z.infer<typeof InsertMcpServerSchema>;
export type UpdateMcpServer = z.infer<typeof UpdateMcpServerSchema>;
