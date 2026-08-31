import { ARCHESTRA_MCP_CATALOG_ID, parseFullToolName } from "@archestra/shared";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  lt,
  // SPDX-SnippetEnd
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import db, { schema, type Transaction } from "@/database";
import { notDeleted } from "@/database/schemas/soft-deletable-table";
import { hardDelete, restore, softDelete } from "@/database/soft-delete";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import { constructFrozenMcpDeploymentName } from "@/k8s/shared";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import { computeSecretStorageType } from "@/secrets-manager/utils";
import { catalogInEnvironmentPredicate } from "@/services/environments/environment-isolation";
import type {
  InsertMcpServer,
  McpServer,
  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  McpServerHibernationMode,
  // SPDX-SnippetEnd
  ResourceVisibilityScope,
  ToolParametersContent,
  UpdateMcpServer,
} from "@/types";
import { externalAppLabel } from "@/utils/external-app-label";
import { toolRequiresInputs } from "@/utils/tool-inputs";
import AgentToolModel from "./agent-tool";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpCatalogTeamModel from "./mcp-catalog-team";
import McpHttpSessionModel from "./mcp-http-session";
import McpServerUserModel from "./mcp-server-user";
import { toolUiResourceUriSql } from "./tool";

// Alias for users table to avoid conflict with the owner LEFT JOIN
const assignedUsersTable = alias(schema.usersTable, "assigned_users");

// Run-time install precedence for an external app (mcp-apps.md FR-31): the
// caller's own personal install wins, then a team install, then an org install.
// Used to order availability scopes, the run-page install list, and the default
// install deterministically rather than by unordered DB result.
const SCOPE_PRECEDENCE: ResourceVisibilityScope[] = ["personal", "team", "org"];
const scopeRank = (scope: ResourceVisibilityScope): number =>
  SCOPE_PRECEDENCE.indexOf(scope);

// SPDX-SnippetBegin
// SPDX-SnippetCopyrightText: 2026 Archestra Inc.
// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
/**
 * Minimum age of `lastUsedAt` before {@link McpServerModel.updateLastUsed}
 * refreshes it. Every proxied MCP request touches the server row, so an
 * unconditional write would turn the row into a lock hot spot — the staleness
 * window collapses a burst into at most one write.
 *
 * @public — consumed by the idle-hibernation sweeper and tests
 */
export const MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS =
  config.orchestrator.mcpIdleHibernation.lastUsedRefreshIntervalMs;

/**
 * How often a server with a call in flight has `lastUsedAt` re-stamped, so a
 * long call cannot age out of its own protection while it is still running.
 * Half the refresh interval, so a running call's row is never more than one
 * interval plus one tick stale — which is exactly the grace the idle sweeper
 * extends its window by.
 *
 * Defined HERE, beside the interval it derives from, rather than next to the
 * tracker that ticks on it: the tracker imports the models barrel, so a
 * sweeper that imported this from the tracker would close an import cycle and
 * read the binding before it was initialised. That cost an outage-shaped bug —
 * `undefined` made the whole idle cutoff NaN, every `>=` against it false, and
 * so every candidate deployment was hibernated no matter how recently used.
 *
 * @public — consumed by the idle-hibernation sweeper, the demand tracker, and tests
 */
export const MCP_DEMAND_HEARTBEAT_INTERVAL_MS =
  config.orchestrator.mcpIdleHibernation.demandHeartbeatIntervalMs;
// SPDX-SnippetEnd

/**
 * Data-access layer for `mcp_server` — an installation of an
 * `internal_mcp_catalog` row (root template or child **preset**) by a
 * specific principal. A single catalog item can back many installs across
 * different scopes (personal/team/org); each install carries its own
 * per-install env values, secret bundle, and lifecycle state.
 *
 * Owns CRUD, scope-aware K8s-safe server-name construction, secret-bundle
 * linkage, agent-tool fan-out, and coordination with
 * `McpServerRuntimeManager` for pod (re)deploys and teardown.
 */
class McpServerModel {
  /**
   * Construct the full server name. Local servers append a scope-specific
   * suffix so distinct installations of the same catalog don't collide on the
   * K8s deployment name. Remote servers use the base name as-is.
   */
  static constructServerName(params: {
    baseName: string;
    serverType: string;
    scope: ResourceVisibilityScope;
    ownerId: string | null;
    teamId: string | null;
  }): string {
    if (params.serverType !== "local") {
      return params.baseName;
    }
    switch (params.scope) {
      case "team":
        if (!params.teamId) {
          throw new Error("teamId required for scope='team' local server");
        }
        return `${params.baseName}-${params.teamId}`;
      case "personal":
        if (!params.ownerId) {
          throw new Error("ownerId required for scope='personal' local server");
        }
        return `${params.baseName}-${params.ownerId}`;
      case "org":
        return params.baseName;
    }
  }

  static async create(
    server: InsertMcpServer,
    tx?: Transaction,
  ): Promise<McpServer> {
    const { userId, ...serverData } = server;

    const mcpServerName = McpServerModel.constructServerName({
      baseName: serverData.name,
      serverType: serverData.serverType,
      scope: serverData.scope ?? "personal",
      ownerId: userId ?? null,
      teamId: serverData.teamId ?? null,
    });

    // Freeze K8s deployment identity at creation (needs the id up front —
    // supplying one is equivalent to the column's defaultRandom()). Renames
    // update `name` but must never re-derive the deployment name; that would
    // orphan the running deployment. Remote installs have no deployment.
    // Multitenant installs share the catalog-level deployment, so this
    // per-install name is simply never read for them.
    const id = crypto.randomUUID();
    const deploymentName =
      serverData.serverType === "local"
        ? constructFrozenMcpDeploymentName(mcpServerName, id)
        : null;

    // ownerId is part of serverData and will be inserted
    const [createdServer] = await (tx ?? db)
      .insert(schema.mcpServersTable)
      .values({ ...serverData, id, name: mcpServerName, deploymentName })
      .returning();

    // Assign user to the MCP server if provided (personal auth)
    if (userId) {
      await McpServerUserModel.assignUserToMcpServer(
        createdServer.id,
        userId,
        tx,
      );
    }

    return {
      ...createdServer,
      users: userId ? [userId] : [],
    };
  }

  /**
   * Writes the frozen `deployment_name`. Deliberately bypasses the
   * UpdateMcpServer type-omit: deployment identity is written exactly once —
   * by `create`, the startup adopt pass, or the rename cascade's
   * freeze-fallback — and never follows the mutable display name.
   */
  static async setDeploymentName(
    params: { id: string; deploymentName: string },
    tx?: Transaction,
  ): Promise<void> {
    await (tx ?? db)
      .update(schema.mcpServersTable)
      .set({ deploymentName: params.deploymentName })
      .where(eq(schema.mcpServersTable.id, params.id));
  }

  /**
   * Get all MCP server IDs that a user has access to through team membership.
   * Simplified query now that teamId is directly on mcp_server table.
   */
  private static async getUserAccessibleMcpServerIdsByTeam(
    userId: string,
  ): Promise<string[]> {
    // Get all MCP servers where the server's teamId matches a team the user is a member of
    const mcpServers = await db
      .select({ mcpServerId: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServersTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.teamMembersTable.userId, userId),
          eq(schema.mcpServersTable.scope, "team"),
          // Active installs only — a soft-deleted team install grants no access.
          notDeleted(schema.mcpServersTable),
        ),
      );

    return mcpServers.map((s) => s.mcpServerId);
  }

  private static async getUserAccessibleMcpServerIds(
    userId: string,
  ): Promise<string[]> {
    const [
      teamAccessibleMcpServerIds,
      personalMcpServerIds,
      orgScopedMcpServerIds,
    ] = await Promise.all([
      McpServerModel.getUserAccessibleMcpServerIdsByTeam(userId),
      McpServerUserModel.getUserPersonalMcpServerIds(userId),
      McpServerModel.getOrgScopedMcpServerIds(),
    ]);
    return [
      ...new Set([
        ...teamAccessibleMcpServerIds,
        ...personalMcpServerIds,
        ...orgScopedMcpServerIds,
      ]),
    ];
  }

  /**
   * The installs whose stored credential `userId` may present to the upstream:
   * the connections they made themselves, and the ones shared with them — a
   * team install of a team they belong to, or an org install.
   *
   * This is the platform's definition of "an install this person may use", and
   * the same set {@link getAccessibleInstallIds} hands the Apps run page. It is
   * deliberately narrower than {@link findById}'s visibility gate and
   * deliberately blind to `mcpServerInstallation:admin`: an installation admin
   * manages every connection in the organization and sees other people's
   * personal ones in the registry, but managing a connection is not the same
   * as being able to authenticate as the person who made it.
   *
   * Ownership is read from BOTH `owner_id` and the `mcp_server_users` join.
   * `create` writes the two together, but they are separate statements, and a
   * row carrying only one of them still belongs to exactly one person — locking
   * someone out of the connection they made is the worse failure of the two.
   *
   * @param restrictToIds when given, only these installs are considered — pass
   * the ids already on the page to keep the org-scope scan bounded.
   */
  static async getCredentialUsableServerIds(
    userId: string,
    restrictToIds?: string[],
  ): Promise<Set<string>> {
    if (restrictToIds?.length === 0) return new Set();

    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.mcpServerUsersTable,
        and(
          eq(schema.mcpServerUsersTable.mcpServerId, schema.mcpServersTable.id),
          eq(schema.mcpServerUsersTable.userId, userId),
        ),
      )
      .leftJoin(
        schema.teamMembersTable,
        and(
          eq(schema.teamMembersTable.teamId, schema.mcpServersTable.teamId),
          eq(schema.teamMembersTable.userId, userId),
        ),
      )
      .where(
        and(
          // Active installs only — a soft-deleted install grants nothing.
          notDeleted(schema.mcpServersTable),
          restrictToIds
            ? inArray(schema.mcpServersTable.id, restrictToIds)
            : undefined,
          or(
            // Their own connection.
            eq(schema.mcpServersTable.ownerId, userId),
            isNotNull(schema.mcpServerUsersTable.userId),
            // Shared with them.
            and(
              eq(schema.mcpServersTable.scope, "team"),
              isNotNull(schema.teamMembersTable.userId),
            ),
            eq(schema.mcpServersTable.scope, "org"),
          ),
        ),
      );

    return new Set(rows.map((row) => row.id));
  }

  /**
   * Single-install form of {@link getCredentialUsableServerIds} — same rule,
   * same query, scoped to one id.
   */
  static async userCanUseCredential(
    userId: string,
    mcpServerId: string,
  ): Promise<boolean> {
    const usable = await McpServerModel.getCredentialUsableServerIds(userId, [
      mcpServerId,
    ]);
    return usable.has(mcpServerId);
  }

  /**
   * Get IDs of org-scoped MCP servers visible to every member of the
   * organization.
   */
  private static async getOrgScopedMcpServerIds(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.scope, "org"),
          // Active installs only — a soft-deleted org install grants no access.
          notDeleted(schema.mcpServersTable),
        ),
      );
    return rows.map((r) => r.id);
  }

  /**
   * Check if a specific MCP server is org-scoped and visible in the given
   * organization.
   */
  private static async hasOrgScopeAccess(
    mcpServerId: string,
  ): Promise<boolean> {
    const result = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.id, mcpServerId),
          eq(schema.mcpServersTable.scope, "org"),
          // Active installs only — a soft-deleted org install grants no access.
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);
    return result.length > 0;
  }

  /**
   * Check if a user has access to a specific MCP server through team membership.
   */
  private static async userHasMcpServerAccessByTeam(
    userId: string,
    mcpServerId: string,
  ): Promise<boolean> {
    // Check if the MCP server's teamId matches any team the user is a member of
    const result = await db
      .select()
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.teamMembersTable,
        eq(schema.mcpServersTable.teamId, schema.teamMembersTable.teamId),
      )
      .where(
        and(
          eq(schema.mcpServersTable.id, mcpServerId),
          eq(schema.teamMembersTable.userId, userId),
          eq(schema.mcpServersTable.scope, "team"),
          // Active installs only — a soft-deleted team install grants no access.
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  /**
   * When the first MCP server was connected; null when none exist. An
   * activation signal for the feedback pop-up.
   */
  static async getFirstCreatedAt(): Promise<Date | null> {
    const [row] = await db
      .select({ createdAt: schema.mcpServersTable.createdAt })
      .from(schema.mcpServersTable)
      .orderBy(asc(schema.mcpServersTable.createdAt))
      .limit(1);
    return row?.createdAt ?? null;
  }

  /**
   * One installed server per catalog, for the periodic tools refresher. Tool
   * rows are shared per catalog item, so re-syncing one install covers every
   * install of that catalog. Only local/remote servers participate — app and
   * builtin servers manage their tools in-process. Oldest install wins for a
   * stable pick across ticks.
   */
  static async findOnePerCatalogForToolsRefresh(): Promise<McpServer[]> {
    return db
      .selectDistinctOn([schema.mcpServersTable.catalogId])
      .from(schema.mcpServersTable)
      .where(
        and(
          isNotNull(schema.mcpServersTable.catalogId),
          inArray(schema.mcpServersTable.serverType, ["local", "remote"]),
          // Active installs only — a soft-deleted install must not drive a tool
          // refresh (its tools are gone with the uninstall).
          notDeleted(schema.mcpServersTable),
        ),
      )
      .orderBy(
        asc(schema.mcpServersTable.catalogId),
        asc(schema.mcpServersTable.createdAt),
      );
  }

  /**
   * Local installation ids visible to one websocket subscriber, without the
   * list endpoint's user, agent, secret and credential enrichment. Deployment
   * status needs only the ids; the visibility rules must stay identical to
   * {@link McpServerModel.findAll}.
   */
  static async findVisibleLocalIds(params: {
    userId: string;
    isMcpServerAdmin: boolean;
    organizationId: string;
    isPredefinedAdmin: boolean;
  }): Promise<string[]> {
    const { userId, isMcpServerAdmin, organizationId, isPredefinedAdmin } =
      params;
    const conditions: SQL[] = [
      notDeleted(schema.mcpServersTable),
      eq(schema.mcpServersTable.serverType, "local"),
    ];
    const catalogBelongsToOrganization = or(
      isNull(schema.internalMcpCatalogTable.organizationId),
      eq(schema.internalMcpCatalogTable.organizationId, organizationId),
    );
    if (catalogBelongsToOrganization) {
      conditions.push(catalogBelongsToOrganization);
    }

    if (!isPredefinedAdmin && isMcpServerAdmin) {
      const sharedOrOwnedInstall = or(
        ne(schema.mcpServersTable.scope, "personal"),
        eq(schema.mcpServersTable.ownerId, userId),
      );
      if (sharedOrOwnedInstall) conditions.push(sharedOrOwnedInstall);
    } else if (!isPredefinedAdmin) {
      const accessibleMcpServerIds =
        await McpServerModel.getUserAccessibleMcpServerIds(userId);
      if (accessibleMcpServerIds.length === 0) return [];
      conditions.push(
        inArray(schema.mcpServersTable.id, accessibleMcpServerIds),
      );
    }

    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(and(...conditions));
    return rows.map((row) => row.id);
  }

  /**
   * @param environmentId when set (null = Default environment), restricts
   * results to deployments whose catalog item is visible from that environment.
   * An MCP server has no environment column of its own — it inherits one from
   * `catalogId`, and a catalog-less (custom/legacy) row counts as Default.
   * Omit for management surfaces that list every environment.
   */
  static async findAll(
    userId?: string,
    isMcpServerAdmin?: boolean,
    organizationId?: string,
    environmentId?: string | null,
    isPredefinedAdmin?: boolean,
  ): Promise<McpServer[]> {
    // Single query with LEFT JOINs for all related data including assigned users,
    // eliminating the consecutive DB query for user details.
    let query = db
      .select({
        server: schema.mcpServersTable,
        ownerEmail: schema.usersTable.email,
        catalogName: schema.internalMcpCatalogTable.name,
        teamName: schema.teamsTable.name,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
        assignedUserId: schema.mcpServerUsersTable.userId,
        assignedUserEmail: assignedUsersTable.email,
        assignedUserCreatedAt: schema.mcpServerUsersTable.createdAt,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpServersTable.ownerId, schema.usersTable.id),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.mcpServersTable.secretId, schema.secretsTable.id),
      )
      .leftJoin(
        schema.mcpServerUsersTable,
        eq(schema.mcpServersTable.id, schema.mcpServerUsersTable.mcpServerId),
      )
      .leftJoin(
        assignedUsersTable,
        eq(schema.mcpServerUsersTable.userId, assignedUsersTable.id),
      )
      .$dynamic();

    const conditions: SQL[] = [
      // Hide soft-deleted installs from every listing path, admin included.
      notDeleted(schema.mcpServersTable),
    ];

    if (organizationId) {
      const catalogBelongsToOrganization = or(
        isNull(schema.internalMcpCatalogTable.organizationId),
        eq(schema.internalMcpCatalogTable.organizationId, organizationId),
      );
      if (catalogBelongsToOrganization) {
        conditions.push(catalogBelongsToOrganization);
      }
    }

    if (environmentId !== undefined) {
      // A server inherits its environment from the joined catalog row; the LEFT
      // JOIN leaves that NULL for catalog-less rows, which `is not distinct
      // from` then matches only for the Default environment.
      conditions.push(catalogInEnvironmentPredicate(environmentId));
    }

    // Only the predefined Admin role may see another user's personal
    // connection. Installation admins still manage every shared installation.
    if (userId && !isPredefinedAdmin && isMcpServerAdmin) {
      const sharedOrOwnedInstall = or(
        ne(schema.mcpServersTable.scope, "personal"),
        eq(schema.mcpServersTable.ownerId, userId),
      );
      if (sharedOrOwnedInstall) conditions.push(sharedOrOwnedInstall);
    } else if (userId && !isPredefinedAdmin) {
      // Get MCP servers accessible through:
      // 1. Team membership (servers assigned to user's teams)
      // 2. Personal access (user's own servers)
      // 3. Org-scoped servers (visible to all org members)
      const accessibleMcpServerIds =
        await McpServerModel.getUserAccessibleMcpServerIds(userId);

      if (accessibleMcpServerIds.length === 0) {
        return [];
      }

      conditions.push(
        inArray(schema.mcpServersTable.id, accessibleMcpServerIds),
      );
    }

    if (conditions.length > 0) {
      query = query.where(and(...conditions));
    }

    const results = await query;

    // Aggregate rows by server (LEFT JOIN on assigned users creates duplicates)
    const serversMap = new Map<string, McpServer>();
    for (const row of results) {
      if (!serversMap.has(row.server.id)) {
        const teamDetails = row.server.teamId
          ? {
              teamId: row.server.teamId,
              name: row.teamName || "",
              createdAt: row.server.createdAt,
            }
          : null;

        const secretStorageType = computeSecretStorageType(
          row.server.secretId,
          row.secretIsVault,
          row.secretIsByosVault,
        );

        serversMap.set(row.server.id, {
          ...row.server,
          ownerEmail: row.ownerEmail,
          catalogName: row.catalogName,
          users: [],
          userDetails: [],
          teamDetails,
          secretStorageType,
        });
      }

      // Append assigned user if present (may be null from LEFT JOIN)
      if (row.assignedUserId) {
        const server = serversMap.get(row.server.id);
        if (server && !server.users?.includes(row.assignedUserId)) {
          server.users?.push(row.assignedUserId);
          server.userDetails?.push({
            userId: row.assignedUserId,
            email: row.assignedUserEmail ?? "",
            createdAt: row.assignedUserCreatedAt ?? new Date(),
          });
        }
      }
    }

    const servers = Array.from(serversMap.values());
    const assignedAgentsByServer =
      await AgentToolModel.getAssignedAgentDetailsForMcpServers([
        ...serversMap.keys(),
      ]);
    // Auto-mode agents (implicit access to all tools) are deliberately NOT
    // decorated here: the set is org-wide and identical for every server, so
    // embedding it repeated the whole roster once per row. It is served once
    // by GET /api/mcp_server/auto_mode_agents instead.

    return servers.map((server) => ({
      ...server,
      assignedAgents: assignedAgentsByServer.get(server.id) ?? [],
    }));
  }

  /**
   * UI-providing catalog items the caller may view, expanded to one entry per
   * accessible install (mcp-apps.md FR-26/FR-27). Drives the external half of
   * the unified Apps listing. A catalog is included when the caller can see it
   * in the registry — no admin bypass, so another user's personal catalog is
   * never surfaced as an app (FR-31) — and it exposes a tool whose
   * `_meta.ui.resourceUri` (or legacy `ui/resourceUri`) names a `ui://`
   * resource. Each `(UI resource × accessible install)` pair becomes its own
   * entry carrying the concrete `mcpServerId` + that install's `scope`, so
   * personal/team/org installs surface as separate cards. Catalogs with no
   * accessible install yield no entries. The built-in Archestra catalog and
   * server-type `app` backings are excluded.
   */
  static async findUiCapableForCaller(params: {
    userId: string;
    organizationId: string;
    search?: string;
  }): Promise<
    Array<{
      catalogId: string;
      mcpServerId: string;
      scope: ResourceVisibilityScope;
      serverName: string;
      serverIcon: string | null;
      toolName: string;
      toolDescription: string | null;
      resourceUri: string;
      /** The tool declares required inputs, so a bare render can't succeed. */
      requiresInput: boolean;
      /** How many UI tools the whole catalog exposes (search-independent). */
      uiToolCount: number;
    }>
  > {
    const { userId, organizationId, search } = params;

    const accessibleCatalogIds =
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        userId,
        false,
        organizationId,
      );
    if (accessibleCatalogIds.length === 0) return [];

    const uiApps = await McpServerModel.getUiApps({
      catalogIds: accessibleCatalogIds,
    });

    // A card's title depends on whether its server exposes one UI tool or
    // several, so count per catalog BEFORE the search filter — a search that
    // matches one of a server's tools must not retitle the surviving card.
    const uiToolCountByCatalog = new Map<string, number>();
    for (const app of uiApps) {
      uiToolCountByCatalog.set(
        app.catalogId,
        (uiToolCountByCatalog.get(app.catalogId) ?? 0) + 1,
      );
    }

    // Case-insensitive substring over the displayed fields (the tool name is
    // matched in its stripped, card-visible form).
    const searchTerm = search?.trim().toLowerCase();
    const matched = searchTerm
      ? uiApps.filter((app) =>
          [
            app.serverName,
            app.serverDescription,
            app.toolName,
            app.toolDescription,
          ].some((field) => field?.toLowerCase().includes(searchTerm)),
        )
      : uiApps;
    if (matched.length === 0) return [];

    // Every UI tool of a catalog shares its installs, so resolve installs once
    // per distinct catalog, then expand each UI resource across them.
    const installsByCatalog =
      await McpServerModel.getAccessibleInstallsByCatalog({
        userId,
        catalogIds: Array.from(new Set(matched.map((a) => a.catalogId))),
      });

    return matched.flatMap((app) =>
      (installsByCatalog.get(app.catalogId) ?? []).map((install) => ({
        catalogId: app.catalogId,
        mcpServerId: install.mcpServerId,
        scope: install.scope,
        serverName: app.serverName,
        serverIcon: app.serverIcon,
        toolName: app.toolName,
        toolDescription: app.toolDescription,
        resourceUri: app.resourceUri,
        requiresInput: toolRequiresInputs(app.toolParameters),
        uiToolCount: uiToolCountByCatalog.get(app.catalogId) ?? 1,
      })),
    );
  }

  /**
   * Validate that `mcpServerId` is an install the caller can reach and that it
   * exposes a `ui://` resource matching `resourceUri`, returning the catalog +
   * label parts (server/tool names) and the tool's input schema for that
   * resource. Backs external open-in-chat (a card's `(mcpServerId,
   * resourceUri)` must resolve to a real, accessible UI resource before a
   * conversation is seeded; the input schema decides render-vs-prompt mode).
   * Several tools of one server can share a resource; pass `toolName` to
   * resolve one specific tool's entry (pinning), omit it to accept any
   * (open-in-chat). Returns null when the install is not accessible or
   * exposes no such resource.
   */
  static async findInstalledUiResourceForCaller(params: {
    userId: string;
    mcpServerId: string;
    resourceUri: string;
    toolName?: string;
  }): Promise<{
    catalogId: string;
    serverName: string;
    serverDescription: string | null;
    toolName: string;
    /** The tool's stored, dispatchable name — never recombine the display pair. */
    fullToolName: string;
    resourceUri: string;
    toolParameters: ToolParametersContent;
    /** How many UI tools the whole catalog exposes — decides the app label. */
    uiToolCount: number;
  } | null> {
    const accessibleServerIds = await McpServerModel.getAccessibleInstallIds(
      params.userId,
    );
    if (!accessibleServerIds.includes(params.mcpServerId)) return null;

    const server = await McpServerModel.findById(params.mcpServerId);
    if (!server?.catalogId) return null;

    const uiApps = await McpServerModel.getUiApps({
      catalogIds: [server.catalogId],
    });
    const match = uiApps.find(
      (a) =>
        a.resourceUri === params.resourceUri &&
        (params.toolName === undefined || a.toolName === params.toolName),
    );
    if (!match) return null;

    return {
      catalogId: server.catalogId,
      serverName: match.serverName,
      serverDescription: match.serverDescription,
      toolName: match.toolName,
      fullToolName: match.fullToolName,
      resourceUri: match.resourceUri,
      toolParameters: match.toolParameters,
      uiToolCount: uiApps.length,
    };
  }

  /**
   * The caller-visible identity of an external (MCP-server) app install: its
   * display name and description, plus the `<slug>__` prefix its tools are
   * really stored under (read off a stored name, since the prefix is a slug of
   * the display name and cannot be derived back from it). Backs the opened-app
   * system-prompt injection, which needs a namespace the model can actually
   * search and call. Returns null when the install is gone, no longer
   * accessible, or exposes no UI resource.
   */
  static async findUiAppIdentityForCaller(params: {
    userId: string;
    mcpServerId: string;
  }): Promise<{
    serverName: string;
    serverDescription: string | null;
    toolNamespace: string | null;
  } | null> {
    const accessibleServerIds = await McpServerModel.getAccessibleInstallIds(
      params.userId,
    );
    if (!accessibleServerIds.includes(params.mcpServerId)) return null;

    const server = await McpServerModel.findById(params.mcpServerId);
    if (!server?.catalogId) return null;

    const [uiApp] = await McpServerModel.getUiApps({
      catalogIds: [server.catalogId],
    });
    if (!uiApp) return null;

    return {
      serverName: uiApp.serverName,
      serverDescription: uiApp.serverDescription,
      toolNamespace: parseFullToolName(uiApp.fullToolName).serverName,
    };
  }

  /**
   * Resolve one UI-providing catalog into its run payload for the caller: all of
   * its `ui://` resources (a server may expose several) plus the caller's
   * accessible installs (mcp-apps.md FR-31), with the default install resolved
   * personal → team → org. `resourceUri` is the default resource; the run page
   * validates `?resource=` against `resources`. Returns null when the caller may
   * not view the catalog or it is not a UI app.
   */
  static async findCatalogAppForCaller(params: {
    userId: string;
    organizationId: string;
    catalogId: string;
  }): Promise<{
    catalogId: string;
    name: string;
    description: string | null;
    resourceUri: string;
    resources: Array<{
      resourceUri: string;
      toolName: string;
      name: string;
      requiresInput: boolean;
    }>;
    defaultMcpServerId: string | null;
    installs: Array<{
      mcpServerId: string;
      scope: ResourceVisibilityScope;
      ownerId: string | null;
      teamId: string | null;
      name: string;
      localInstallationStatus: string | null;
    }>;
  } | null> {
    const { userId, organizationId, catalogId } = params;

    const accessibleCatalogIds =
      await McpCatalogTeamModel.getUserAccessibleCatalogIds(
        userId,
        false,
        organizationId,
      );
    if (!accessibleCatalogIds.includes(catalogId)) return null;

    const uiApps = await McpServerModel.getUiApps({ catalogIds: [catalogId] });
    const primary = uiApps[0];
    if (!primary) return null;

    const installs = await McpServerModel.findAccessibleInstallsForCatalog({
      userId,
      catalogId,
    });

    return {
      catalogId,
      name: primary.serverName,
      description: primary.toolDescription,
      resourceUri: primary.resourceUri,
      resources: uiApps.map((app) => ({
        resourceUri: app.resourceUri,
        toolName: app.toolName,
        name: externalAppLabel({
          serverName: app.serverName,
          toolName: app.toolName,
          uiToolCount: uiApps.length,
        }),
        requiresInput: toolRequiresInputs(app.toolParameters),
      })),
      defaultMcpServerId: McpServerModel.pickDefaultInstall(installs),
      installs,
    };
  }

  /**
   * The caller's accessible installs of one catalog (mcp-apps.md FR-31): own
   * personal + team + org installs. Another user's personal install is excluded.
   */
  private static async findAccessibleInstallsForCatalog(params: {
    userId: string;
    catalogId: string;
  }): Promise<
    Array<{
      mcpServerId: string;
      scope: ResourceVisibilityScope;
      ownerId: string | null;
      teamId: string | null;
      name: string;
      localInstallationStatus: string | null;
    }>
  > {
    const accessibleServerIds = await McpServerModel.getAccessibleInstallIds(
      params.userId,
    );
    if (accessibleServerIds.length === 0) return [];
    const rows = await db
      .select({
        mcpServerId: schema.mcpServersTable.id,
        scope: schema.mcpServersTable.scope,
        ownerId: schema.mcpServersTable.ownerId,
        teamId: schema.mcpServersTable.teamId,
        name: schema.mcpServersTable.name,
        localInstallationStatus: schema.mcpServersTable.localInstallationStatus,
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.id, accessibleServerIds),
          eq(schema.mcpServersTable.catalogId, params.catalogId),
          // Active installs only — a soft-deleted install is not a live app.
          notDeleted(schema.mcpServersTable),
        ),
      );
    // Stable selector order: scope precedence, then name.
    return rows.sort(
      (a, b) =>
        scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name),
    );
  }

  /**
   * UI-providing apps among `catalogIds`: one row per UI tool. A single server
   * (catalog) may expose several `ui://` resources, so each becomes its own app
   * (no per-catalog dedup). `serverName` is the catalog display name; `toolName`
   * is the tool's short name (the server prefix is stripped, so a stored
   * `excalidraw__create_view` surfaces as `create_view`); `toolDescription` is
   * the tool's own description. Sorted by server then tool for a stable listing.
   * Always unfiltered — callers that search do so over the returned rows, so a
   * catalog's full UI-tool count stays observable (it decides card titles).
   */
  private static async getUiApps(params: { catalogIds: string[] }): Promise<
    Array<{
      catalogId: string;
      serverName: string;
      serverDescription: string | null;
      serverIcon: string | null;
      toolName: string;
      /**
       * The tool's stored, dispatchable name (`<server-slug>__<tool>`). Unlike
       * `serverName`/`toolName` — a display pair that cannot be recombined into
       * it — this is the only form a tool call may use.
       */
      fullToolName: string;
      toolDescription: string | null;
      resourceUri: string;
      toolParameters: ToolParametersContent;
    }>
  > {
    const { catalogIds } = params;
    if (catalogIds.length === 0) return [];
    const uiResourceUri = toolUiResourceUriSql();
    const rows = await db
      .select({
        catalogId: schema.internalMcpCatalogTable.id,
        serverName: schema.internalMcpCatalogTable.name,
        serverDescription: schema.internalMcpCatalogTable.description,
        serverIcon: schema.internalMcpCatalogTable.icon,
        toolName: schema.toolsTable.name,
        toolDescription: schema.toolsTable.description,
        resourceUri: uiResourceUri,
        toolParameters: schema.toolsTable.parameters,
      })
      .from(schema.internalMcpCatalogTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.toolsTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          inArray(schema.internalMcpCatalogTable.id, catalogIds),
          ne(schema.internalMcpCatalogTable.id, ARCHESTRA_MCP_CATALOG_ID),
          // serverType "app" backings are owned apps, served viewer-scoped under
          // the platform CSP — never surfaced as external apps.
          ne(schema.internalMcpCatalogTable.serverType, "app"),
          // A soft-deleted catalog (and its soft-deleted tools) must not surface
          // as an app.
          notDeleted(schema.internalMcpCatalogTable),
          notDeleted(schema.toolsTable),
          sql`${uiResourceUri} IS NOT NULL`,
        ),
      );

    return rows
      .flatMap((row) =>
        row.resourceUri
          ? [
              {
                catalogId: row.catalogId,
                serverName: row.serverName,
                serverDescription: row.serverDescription,
                serverIcon: row.serverIcon,
                // Strip the server prefix: catalog tools are stored as
                // `<server>__<tool>`, but the card shows just the tool. The
                // stripped pair is for display only — `serverName` is the
                // catalog's human name while the stored prefix is a slug of it,
                // so recombining the two fabricates a name that dispatches
                // nowhere. Carry the stored name for anything that must call it.
                toolName: parseFullToolName(row.toolName).toolName,
                fullToolName: row.toolName,
                toolDescription: row.toolDescription,
                resourceUri: row.resourceUri,
                toolParameters: row.toolParameters,
              },
            ]
          : [],
      )
      .sort(
        (a, b) =>
          a.serverName.localeCompare(b.serverName) ||
          a.toolName.localeCompare(b.toolName),
      );
  }

  /**
   * The caller's accessible installs keyed by catalog, each `{ mcpServerId,
   * scope }`. Installs are ordered by scope precedence (personal → team → org)
   * then name, giving the Apps listing a stable per-install order.
   */
  private static async getAccessibleInstallsByCatalog(params: {
    userId: string;
    catalogIds: string[];
  }): Promise<
    Map<string, Array<{ mcpServerId: string; scope: ResourceVisibilityScope }>>
  > {
    const map = new Map<
      string,
      Array<{ mcpServerId: string; scope: ResourceVisibilityScope }>
    >();
    if (params.catalogIds.length === 0) return map;
    const accessibleServerIds = await McpServerModel.getAccessibleInstallIds(
      params.userId,
    );
    if (accessibleServerIds.length === 0) return map;
    const rows = await db
      .select({
        catalogId: schema.mcpServersTable.catalogId,
        mcpServerId: schema.mcpServersTable.id,
        scope: schema.mcpServersTable.scope,
        name: schema.mcpServersTable.name,
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.id, accessibleServerIds),
          inArray(schema.mcpServersTable.catalogId, params.catalogIds),
          // Active installs only — a soft-deleted install is not a live app.
          notDeleted(schema.mcpServersTable),
        ),
      );
    rows.sort(
      (a, b) =>
        scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name),
    );
    for (const r of rows) {
      const list = map.get(r.catalogId) ?? [];
      list.push({ mcpServerId: r.mcpServerId, scope: r.scope });
      map.set(r.catalogId, list);
    }
    return map;
  }

  /** Union of the caller's accessible install ids: own personal + team + org. */
  private static async getAccessibleInstallIds(
    userId: string,
  ): Promise<string[]> {
    return [...(await McpServerModel.getCredentialUsableServerIds(userId))];
  }

  /** Default install for a run: personal → team → org (mcp-apps.md FR-31). */
  private static pickDefaultInstall(
    installs: Array<{ mcpServerId: string; scope: ResourceVisibilityScope }>,
  ): string | null {
    for (const scope of SCOPE_PRECEDENCE) {
      const match = installs.find((i) => i.scope === scope);
      if (match) return match.mcpServerId;
    }
    return null;
  }

  static async findById(
    id: string,
    userId?: string,
    isMcpServerAdmin?: boolean,
  ): Promise<McpServer | null> {
    // Check access control for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      const [hasTeamAccess, hasPersonalAccess, hasOrgAccess] =
        await Promise.all([
          McpServerModel.userHasMcpServerAccessByTeam(userId, id),
          McpServerUserModel.userHasPersonalMcpServerAccess(userId, id),
          McpServerModel.hasOrgScopeAccess(id),
        ]);

      if (!hasTeamAccess && !hasPersonalAccess && !hasOrgAccess) {
        return null;
      }
    }

    const [result] = await db
      .select({
        server: schema.mcpServersTable,
        ownerEmail: schema.usersTable.email,
        teamName: schema.teamsTable.name,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpServersTable.ownerId, schema.usersTable.id),
      )
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.secretsTable,
        eq(schema.mcpServersTable.secretId, schema.secretsTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          notDeleted(schema.mcpServersTable),
        ),
      );

    if (!result) {
      return null;
    }

    const [userDetails, assignedAgentsByServer] = await Promise.all([
      McpServerUserModel.getUserDetailsForMcpServer(id),
      AgentToolModel.getAssignedAgentDetailsForMcpServers([id]),
    ]);

    // Build teamDetails from the joined team data
    const teamDetails = result.server.teamId
      ? {
          teamId: result.server.teamId,
          name: result.teamName || "",
          createdAt: result.server.createdAt,
        }
      : null;

    // Compute secret storage type
    const secretStorageType = computeSecretStorageType(
      result.server.secretId,
      result.secretIsVault,
      result.secretIsByosVault,
    );

    return {
      ...result.server,
      ownerEmail: result.ownerEmail,
      users: userDetails.map((u) => u.userId),
      userDetails,
      teamDetails,
      secretStorageType,
      assignedAgents: assignedAgentsByServer.get(id) ?? [],
    };
  }

  /**
   * Find multiple MCP servers by IDs with a single query.
   * Returns basic table records (no JOINs) for lightweight validation.
   */
  static async findByIdsBasic(
    ids: string[],
  ): Promise<(typeof schema.mcpServersTable.$inferSelect)[]> {
    if (ids.length === 0) return [];

    return db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.id, ids),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  /**
   * Resolve a server only within an organization. `mcp_server` has no org
   * column, so org membership is inferred exactly like {@link findByIdForAudit}
   * (team-in-org OR owner-is-member OR a legacy unowned+teamless system row).
   * Foreign-org servers return null — used to org-scope app tool assignment.
   */
  static async findByIdInOrg(
    id: string,
    organizationId: string,
  ): Promise<McpServer | null> {
    const [row] = await db
      .select({ server: schema.mcpServersTable })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.mcpServersTable.ownerId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          notDeleted(schema.mcpServersTable),
          or(
            eq(schema.teamsTable.organizationId, organizationId),
            isNotNull(schema.membersTable.id),
            and(
              isNull(schema.mcpServersTable.teamId),
              isNull(schema.mcpServersTable.ownerId),
            ),
          ),
        ),
      )
      .limit(1);
    return row?.server ?? null;
  }

  static async findByCatalogId(
    catalogId: string,
    tx?: Transaction,
  ): Promise<McpServer[]> {
    // Active installs only. This feeds the catalog delete cascade (which wants
    // live installs to soft-delete) AND the multitenant sibling count in
    // `isSharedMultitenantDeployment` — without `notDeleted` a soft-deleted
    // sibling would keep the shared pod alive forever after a cascade delete.
    return await (tx ?? db)
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.catalogId, catalogId),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  static async findByCatalogIds(catalogIds: string[]): Promise<McpServer[]> {
    if (catalogIds.length === 0) return [];
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.catalogId, catalogIds),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  static async findCustomServers(): Promise<McpServer[]> {
    // Find servers that don't have a catalogId (custom installations)
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          isNull(schema.mcpServersTable.catalogId),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  static async update(
    id: string,
    server: Partial<UpdateMcpServer>,
    tx?: Transaction,
  ): Promise<McpServer | null> {
    // Invariant: `reinstallReason` is null iff `reinstallRequired` is false.
    // Clearing the flag drops the reason; flagging without one defaults to
    // "new-input" so the UI errs toward collecting values.
    const serverData: Partial<UpdateMcpServer> =
      server.reinstallRequired === false
        ? { ...server, reinstallReason: null }
        : server.reinstallRequired === true && server.reinstallReason == null
          ? { ...server, reinstallReason: "new-input" }
          : server;

    let updatedServer: McpServer | undefined;

    // Only update server table if there are fields to update
    if (Object.keys(serverData).length > 0) {
      [updatedServer] = await (tx ?? db)
        .update(schema.mcpServersTable)
        .set(serverData)
        .where(eq(schema.mcpServersTable.id, id))
        .returning();

      if (!updatedServer) {
        return null;
      }
    } else {
      // No fields to update, fetch the existing server
      const [existingServer] = await (tx ?? db)
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, id));

      if (!existingServer) {
        return null;
      }

      updatedServer = existingServer;
    }

    return updatedServer;
  }

  /**
   * Persist a terminal OAuth refresh failure on an install.
   *
   * The three cause fields carry the latest diagnosis and are overwritten every
   * time, but `oauthRefreshFailedAt` is a FIRST-failure stamp: it is written
   * only on the transition into the failed state. Re-observing the same fault —
   * which happens on every subsequent tool call against a connection whose
   * credential is dead — leaves it alone.
   *
   * That is what makes the timestamp an episode key rather than a last-attempt
   * clock: the registry's "failing since" reads the moment the fault began, and
   * a viewer's alert mute pinned to it is not knocked loose seconds after it
   * was taken. Clearing the fault (the null write, paired with dropping the
   * connection's mutes) ends the episode.
   *
   * `coalesce` keeps the read and the write in one statement, so two concurrent
   * failures cannot both conclude they are the transition.
   */
  static async recordOAuthRefreshFailure(
    id: string,
    failure: {
      oauthRefreshError: "refresh_failed" | "no_refresh_token";
      oauthRefreshErrorMessage: string;
      oauthRefreshErrorDescription: string | null;
      /**
       * When this failure was observed. Persisted only when the install was not
       * already failing; otherwise the existing stamp wins.
       */
      oauthRefreshFailedAt: Date;
    },
  ): Promise<void> {
    await db
      .update(schema.mcpServersTable)
      .set({
        oauthRefreshError: failure.oauthRefreshError,
        oauthRefreshErrorMessage: failure.oauthRefreshErrorMessage,
        oauthRefreshErrorDescription: failure.oauthRefreshErrorDescription,
        oauthRefreshFailedAt: sql`coalesce(${schema.mcpServersTable.oauthRefreshFailedAt}, ${failure.oauthRefreshFailedAt.toISOString()})`,
      })
      .where(eq(schema.mcpServersTable.id, id));
  }

  /** Atomically move every install sharing one reset to the same status. */
  static async updateInstallationStatuses(params: {
    ids: string[];
    status: "pending" | "success" | "error";
    error: string | null;
    expected?: {
      status: "pending" | "success" | "error";
      error: string | null;
    };
    tx?: Transaction;
  }): Promise<string[]> {
    const ids = [...new Set(params.ids)];
    if (ids.length === 0) return [];
    const rows = await (params.tx ?? db)
      .update(schema.mcpServersTable)
      .set({
        localInstallationStatus: params.status,
        localInstallationError: params.error,
      })
      .where(
        and(
          inArray(schema.mcpServersTable.id, ids),
          params.expected
            ? eq(
                schema.mcpServersTable.localInstallationStatus,
                params.expected.status,
              )
            : undefined,
          params.expected
            ? params.expected.error === null
              ? isNull(schema.mcpServersTable.localInstallationError)
              : eq(
                  schema.mcpServersTable.localInstallationError,
                  params.expected.error,
                )
            : undefined,
        ),
      )
      .returning({ id: schema.mcpServersTable.id });
    return rows.map(({ id }) => id);
  }

  /** Pending installs carrying one internal operation-marker prefix. */
  static async findPendingInstallationsByErrorPrefix(
    errorPrefix: string,
  ): Promise<Array<{ id: string; localInstallationError: string | null }>> {
    return db
      .select({
        id: schema.mcpServersTable.id,
        localInstallationError: schema.mcpServersTable.localInstallationError,
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.localInstallationStatus, "pending"),
          like(
            schema.mcpServersTable.localInstallationError,
            `${errorPrefix}%`,
          ),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }

  // SPDX-SnippetBegin
  // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
  // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
  /**
   * Refresh `lastUsedAt` for a server that just handled a request.
   *
   * Skips the write when `lastUsedAt` is already fresh (see
   * {@link MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS}); concurrent callers that
   * lose the race re-check the condition after the winner commits and skip
   * too. `updatedAt` is deliberately pinned to its current value so a pure
   * usage touch never churns it (drizzle's `$onUpdate` would otherwise bump it
   * on every update).
   */
  static async updateLastUsed(id: string): Promise<void> {
    const cutoff = new Date(
      Date.now() - MCP_SERVER_LAST_USED_REFRESH_INTERVAL_MS,
    );
    await db
      .update(schema.mcpServersTable)
      .set({
        lastUsedAt: new Date(),
        // No-op self-assignment: overrides the column's $onUpdate bump.
        updatedAt: sql`${schema.mcpServersTable.updatedAt}`,
      })
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          or(
            isNull(schema.mcpServersTable.lastUsedAt),
            lt(schema.mcpServersTable.lastUsedAt, cutoff),
          ),
        ),
      );
  }

  /** Grant every live install a full idle window before hibernation is enabled. */
  static async grantIdleWindowToAll(): Promise<void> {
    await db
      .update(schema.mcpServersTable)
      .set({
        lastUsedAt: new Date(),
        // No-op self-assignment: overrides the column's $onUpdate bump.
        updatedAt: sql`${schema.mcpServersTable.updatedAt}`,
      })
      .where(notDeleted(schema.mcpServersTable));
  }

  /**
   * Latest usage timestamp across the given (non-deleted) servers, treating a
   * NULL `lastUsedAt` as "never used since creation" via `createdAt`. Returns
   * null for empty input or when none of the ids match an active row.
   */
  static async getLatestUsageAt(ids: string[]): Promise<Date | null> {
    if (ids.length === 0) return null;

    const [row] = await db
      .select({
        // mapWith reuses the timestamp column's decoder so the aggregate's
        // driver string is parsed as UTC, exactly like a plain column read
        latest:
          sql`max(coalesce(${schema.mcpServersTable.lastUsedAt}, ${schema.mcpServersTable.createdAt}))`.mapWith(
            schema.mcpServersTable.createdAt,
          ),
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.id, ids),
          notDeleted(schema.mcpServersTable),
        ),
      );

    return row?.latest ?? null;
  }

  /**
   * The per-install idle-hibernation modes of the given (non-deleted)
   * servers. Projected to the one column the sweeper resolves the group's
   * verdict from — it runs over every loaded deployment on a timer, so it
   * must not pull whole rows to read a single enum.
   */
  static async getHibernationModes(
    ids: string[],
  ): Promise<McpServerHibernationMode[]> {
    if (ids.length === 0) return [];

    const rows = await db
      .select({ hibernationMode: schema.mcpServersTable.hibernationMode })
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.id, ids),
          notDeleted(schema.mcpServersTable),
        ),
      );

    return rows.map((row) => row.hibernationMode);
  }

  /**
   * Cascade the idle-hibernation override onto every live install of a
   * catalog. The registry's server settings dialog is catalog-scoped, so its
   * PUT writes through here; the reinstall route remains the path for setting
   * a single installation apart. `updatedAt` is deliberately pinned — an
   * operational toggle is not a config edit.
   */
  static async setHibernationModeForCatalog(
    catalogId: string,
    hibernationMode: McpServerHibernationMode,
  ): Promise<void> {
    await db
      .update(schema.mcpServersTable)
      .set({
        hibernationMode,
        // No-op self-assignment: overrides the column's $onUpdate bump.
        updatedAt: sql`${schema.mcpServersTable.updatedAt}`,
      })
      .where(
        and(
          eq(schema.mcpServersTable.catalogId, catalogId),
          notDeleted(schema.mcpServersTable),
        ),
      );
  }
  // SPDX-SnippetEnd

  /**
   * Set the visibility scope of an MCP server. For installed servers scope is
   * install-time-only (changed via uninstall+reinstall), but an app backing
   * server is in-process with no deployment, so its scope can be re-pointed in
   * place to track the app's scope.
   */
  static async setScope(
    id: string,
    scope: ResourceVisibilityScope,
  ): Promise<void> {
    await db
      .update(schema.mcpServersTable)
      .set({ scope })
      .where(eq(schema.mcpServersTable.id, id));
  }

  /**
   * Set the team for an MCP server. Pass null to remove team assignment.
   */
  static async setTeam(
    id: string,
    teamId: string | null,
  ): Promise<McpServer | null> {
    const [updatedServer] = await db
      .update(schema.mcpServersTable)
      .set({ teamId })
      .where(eq(schema.mcpServersTable.id, id))
      .returning();

    return updatedServer || null;
  }

  static async delete(id: string, opts?: { at?: Date }): Promise<boolean> {
    // Fetch the (active) server for teardown context. Idempotent: an
    // already-soft-deleted server is not found (findById filters notDeleted),
    // so a repeat delete is a no-op and returns false.
    const mcpServer = await McpServerModel.findById(id);

    if (!mcpServer) {
      return false;
    }

    // Clean up any persisted HTTP session IDs tied to this server.
    // Without this, stale rows can linger until TTL cleanup after uninstall/delete.
    try {
      await McpHttpSessionModel.deleteByMcpServerId(id);
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to clean up MCP HTTP sessions for MCP server ${mcpServer.name}:`,
      );
      // Continue with deletion even if session cleanup fails
    }

    // Uninstall retains the catalog's tools, their policies, and the agent ↔ tool
    // assignments so reconnecting the catalog item restores them. The soft delete
    // below keeps the mcp_server row, so each assignment's server binding stays
    // pointed at the soft-deleted install (the agent_tools FK never fires); a
    // tool's availability is derived from whether the catalog still has an
    // active install, not from removing these rows.

    // For local servers, stop and remove the K8s deployment
    if (mcpServer.serverType === "local") {
      try {
        await McpServerRuntimeManager.removeMcpServer(id);
        logger.info(
          `Cleaned up K8s deployment for MCP server: ${mcpServer.name}`,
        );
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to clean up K8s deployment for MCP server ${mcpServer.name}:`,
        );
        // Continue with deletion even if pod cleanup fails
      }
    }

    // Soft-delete: keep the DB row AND its secret bag so restore can recover the
    // definition + stored credentials. The live K8s deployment + K8s Secret were
    // torn down above; a manual Reinstall re-materializes them from the retained
    // secret. `opts.at` lets a catalog cascade stamp this install (with its
    // siblings and tools) with one shared timestamp — the restore correlation key.
    logger.info(`Soft-deleting MCP server: ${mcpServer.name} with id: ${id}`);
    const count = await softDelete(
      db,
      schema.mcpServersTable,
      eq(schema.mcpServersTable.id, id),
      opts?.at,
    );
    return count > 0;
  }

  /**
   * Restore a single soft-deleted install (standalone server-restore route).
   * Flag-only: does NOT re-provision — stamps `reinstallRequired` so the user
   * completes a manual Reinstall (which uses the retained DB secret).
   */
  static async restore(id: string): Promise<boolean> {
    const count = await restore(
      db,
      schema.mcpServersTable,
      eq(schema.mcpServersTable.id, id),
    );
    if (count > 0) {
      await db
        .update(schema.mcpServersTable)
        .set({ reinstallRequired: true, reinstallReason: "new-input" })
        .where(eq(schema.mcpServersTable.id, id));
    }
    return count > 0;
  }

  /**
   * Restore exactly the installs a catalog delete cascaded, matched by the
   * shared `deletedAt` timestamp (the correlation key). Installs deleted
   * individually before the catalog carry a different timestamp and are NOT
   * revived. Flag-only: single-tenant installs are flagged for per-install
   * reinstall; multitenant installs come back via the catalog-level reinstall
   * (`catalogReinstallRequired`, stamped by the catalog restore), so they are
   * not per-install flagged here.
   */
  static async restoreCascadedForCatalog(
    params: { catalogId: string; deletedAt: Date; multitenant: boolean },
    tx?: Transaction,
  ): Promise<number> {
    const restored = await (tx ?? db)
      .update(schema.mcpServersTable)
      .set(
        params.multitenant
          ? { deletedAt: null }
          : {
              deletedAt: null,
              reinstallRequired: true,
              reinstallReason: "new-input",
            },
      )
      .where(
        and(
          eq(schema.mcpServersTable.catalogId, params.catalogId),
          eq(schema.mcpServersTable.deletedAt, params.deletedAt),
        ),
      )
      .returning({ id: schema.mcpServersTable.id });
    return restored.length;
  }

  /** Physical delete — reserved for install-create rollback (never a ghost row). */
  static async hardDelete(id: string): Promise<boolean> {
    const count = await hardDelete(
      db,
      schema.mcpServersTable,
      eq(schema.mcpServersTable.id, id),
    );
    return count > 0;
  }

  /**
   * Purge a user's personal MCP installs and the credentials they hold, for
   * user deletion. Called by {@link UserModel.delete} — the user row itself is
   * not touched here.
   *
   * `scope = 'personal'` is the discriminator, NOT `owner_id`: org- and
   * team-scoped installs legitimately outlive their installer and must survive.
   *
   * Soft-deleted installs are purged too. Uninstall deliberately RETAINS the
   * secret bag so a restore recovers stored credentials, but once the owner is
   * gone nobody can restore it — the retained row is pure credential residue.
   *
   * Unlike {@link delete} (soft, recoverable) this hard-deletes: an ownerless
   * personal install is unreachable and unrestorable, and `owner_id`'s
   * `set null` FK would otherwise strand it with its secret intact. Every FK
   * pointing at `mcp_server` is `set null` or `cascade`, so the row goes
   * cleanly.
   *
   * Best-effort per install: a failed K8s teardown or secret delete is logged
   * and the purge continues, so one wedged install can't block the deletion.
   */
  /**
   * Transaction-scoped variant of {@link purgePersonalServersForUser} for
   * callers already inside a database transaction (temp-user cleanup in auth
   * flows). SQL only, on the caller's executor: base-db queries under an open
   * transaction deadlock the single-connection test database, and the full
   * purge's runtime/secret-manager side effects cannot join a transaction
   * anyway. Mirrors the backfill migration's semantics — install rows go,
   * plain secret rows go with them, Vault/BYOS secret rows are RETAINED (SQL
   * cannot reach the backing store; the row is the only pointer left for a
   * manual sweep). No K8s teardown: these auth-flow shell users cannot have
   * running local installs.
   */
  static async purgePersonalServersForUserInTransaction(
    userId: string,
    tx: Transaction,
  ): Promise<void> {
    const servers = await tx
      .select({
        id: schema.mcpServersTable.id,
        secretId: schema.mcpServersTable.secretId,
        secretIsVault: schema.secretsTable.isVault,
        secretIsByosVault: schema.secretsTable.isByosVault,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.secretsTable,
        eq(schema.mcpServersTable.secretId, schema.secretsTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.scope, "personal"),
        ),
      );

    if (servers.length === 0) {
      return;
    }

    // Install rows first: `mcp_server.secret_id` is `set null`, so deleting
    // the secret first would erase the pointer mid-flight.
    await tx.delete(schema.mcpServersTable).where(
      inArray(
        schema.mcpServersTable.id,
        servers.map((server) => server.id),
      ),
    );

    const plainSecretIds = servers
      .filter(
        (server) =>
          server.secretId && !server.secretIsVault && !server.secretIsByosVault,
      )
      .map((server) => server.secretId as string);
    if (plainSecretIds.length > 0) {
      await tx
        .delete(schema.secretsTable)
        .where(inArray(schema.secretsTable.id, plainSecretIds));
    }

    logger.info(
      { userId, purgedCount: servers.length },
      "McpServerModel.purgePersonalServersForUserInTransaction: purged personal MCP installs and their credentials",
    );
  }

  static async purgePersonalServersForUser(userId: string): Promise<string[]> {
    // Deliberately NOT filtered by `notDeleted` — retained secrets on
    // soft-deleted installs are exactly the residue this purge exists to clear.
    const servers = await db
      .select({
        id: schema.mcpServersTable.id,
        serverType: schema.mcpServersTable.serverType,
        secretId: schema.mcpServersTable.secretId,
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.scope, "personal"),
        ),
      );

    return McpServerModel.purgeInstallRows(userId, servers);
  }

  /**
   * Like {@link purgePersonalServersForUser}, but limited to installs whose
   * catalog belongs to the given organization — the shape of cleanup that runs
   * when a user loses their MEMBERSHIP in one organization rather than their
   * account. `mcp_server` has no organization column, so the catalog's
   * `organization_id` is the discriminator; installs on catalogs without one
   * (legacy/system-seeded, globally visible) are deliberately left alone
   * because they cannot be attributed to the organization being left.
   */
  static async purgePersonalServersForUserInOrganization(
    userId: string,
    organizationId: string,
  ): Promise<string[]> {
    const servers = await db
      .select({
        id: schema.mcpServersTable.id,
        serverType: schema.mcpServersTable.serverType,
        secretId: schema.mcpServersTable.secretId,
      })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.scope, "personal"),
          eq(schema.internalMcpCatalogTable.organizationId, organizationId),
        ),
      );

    return McpServerModel.purgeInstallRows(userId, servers);
  }

  /**
   * Org-scoped lookup of a SOFT-DELETED install for the restore route.
   * `mcp_server` has no `organization_id` column, so org membership is inferred
   * via the same team/member join as {@link findByIdInOrg}; the predicate flips
   * to `deleted_at IS NOT NULL`. `teamId`/`ownerId` survive soft-delete (they are
   * `set null` FKs only a hard delete clears), so the inference join still resolves.
   */
  static async findDeletedByIdForOrganization(
    id: string,
    organizationId: string,
  ): Promise<McpServer | null> {
    const [row] = await db
      .select({ server: schema.mcpServersTable })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.mcpServersTable.ownerId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          isNotNull(schema.mcpServersTable.deletedAt),
          or(
            eq(schema.teamsTable.organizationId, organizationId),
            isNotNull(schema.membersTable.id),
            and(
              isNull(schema.mcpServersTable.teamId),
              isNull(schema.mcpServersTable.ownerId),
            ),
          ),
        ),
      )
      .limit(1);
    return row?.server ?? null;
  }

  /**
   * Restore-conflict guard mirroring the install-time at-most-one-active-install
   * invariant (routes/mcp-server.ts) across ALL scopes — not just personal.
   * Returns a user-facing message when restoring `server` would create a second
   * active install for the same catalog + scope, else null. Compares against
   * active (non-deleted) installs and excludes the server being restored.
   */
  static async getRestoreConflictMessage(
    server: McpServer,
  ): Promise<string | null> {
    if (!server.catalogId) return null;
    const active = (
      await McpServerModel.findByCatalogId(server.catalogId)
    ).filter((s) => s.id !== server.id);

    if (server.scope === "personal") {
      if (
        active.some(
          (s) => s.scope === "personal" && s.ownerId === server.ownerId,
        )
      ) {
        return "Cannot restore because you already have an active installation of this MCP server.";
      }
    } else if (server.scope === "team") {
      if (
        active.some((s) => s.scope === "team" && s.teamId === server.teamId)
      ) {
        return "Cannot restore because this team already has an active installation of this MCP server.";
      }
    } else if (server.scope === "org") {
      if (active.some((s) => s.scope === "org")) {
        return "Cannot restore because this organization already has an active installation of this MCP server.";
      }
    }
    return null;
  }

  /**
   * Get the list of tools from a specific MCP server instance
   */
  static async getToolsFromServer(mcpServer: McpServer): Promise<
    Array<{
      name: string;
      description: string;
      inputSchema: Record<string, unknown>;
      _meta?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }>
  > {
    // Get catalog information if this server was installed from a catalog
    let catalogItem = null;
    if (mcpServer.catalogId) {
      catalogItem = await InternalMcpCatalogModel.findById(mcpServer.catalogId);
    }

    if (!catalogItem) {
      logger.warn(
        `No catalog item found for MCP server ${mcpServer.name}, cannot fetch tools`,
      );
      return [];
    }

    // Load secrets if secretId is present
    let secrets: Record<string, unknown> = {};
    if (mcpServer.secretId) {
      const secretRecord = await secretManager().getSecret(mcpServer.secretId);
      if (secretRecord) {
        secrets = secretRecord.secret;
      }
    }

    try {
      // Use the new structured API for all server types
      const tools = await mcpClient.connectAndGetTools({
        catalogItem,
        mcpServerId: mcpServer.id,
        secrets,
        secretId: mcpServer.secretId ?? undefined,
      });

      // Transform to ensure description is always a string
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        inputSchema: tool.inputSchema,
        _meta: tool._meta,
        annotations: tool.annotations,
      }));
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to get tools from MCP server ${mcpServer.name} (type: ${catalogItem.serverType}):`,
      );
      throw error;
    }
  }

  /**
   * Find an MCP server by catalogId that has a matching team from the provided team IDs.
   * Returns the first matching server with a secretId for credential resolution.
   * Used for dynamic team-based credential resolution.
   */
  static async findByCatalogIdWithMatchingTeams(
    catalogId: string,
    teamIds: string[],
  ): Promise<McpServer | null> {
    if (teamIds.length === 0) {
      return null;
    }

    // Find MCP server with matching catalog AND matching team AND has a secretId
    const [result] = await db
      .select({
        server: schema.mcpServersTable,
        teamName: schema.teamsTable.name,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.catalogId, catalogId),
          inArray(schema.mcpServersTable.teamId, teamIds),
          isNotNull(schema.mcpServersTable.secretId),
          // Active installs only — a soft-deleted team install must not be
          // resolved as a live credential source.
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);

    if (!result) {
      return null;
    }

    const teamDetails = result.server.teamId
      ? {
          teamId: result.server.teamId,
          name: result.teamName || "",
          createdAt: result.server.createdAt,
        }
      : null;

    return {
      ...result.server,
      teamDetails,
    };
  }

  /**
   * Get a user's personal server for a specific catalog.
   */
  static async getUserPersonalServerForCatalog(
    userId: string,
    catalogId: string,
  ): Promise<McpServer | null> {
    const [result] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          eq(schema.mcpServersTable.catalogId, catalogId),
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.scope, "personal"),
          notDeleted(schema.mcpServersTable),
        ),
      )
      .limit(1);

    return result || null;
  }

  /**
   * Get a user's personal servers for multiple catalogs in a single query.
   * Returns a Map of catalogId -> McpServer for catalogs where the user has a personal server.
   */
  static async getUserPersonalServersForCatalogs(
    userId: string,
    catalogIds: string[],
  ): Promise<Map<string, McpServer>> {
    if (catalogIds.length === 0) {
      return new Map();
    }

    const results = await db
      .select()
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.catalogId, catalogIds),
          eq(schema.mcpServersTable.ownerId, userId),
          eq(schema.mcpServersTable.scope, "personal"),
          notDeleted(schema.mcpServersTable),
        ),
      );

    const serversByCatalog = new Map<string, McpServer>();
    for (const server of results) {
      if (server.catalogId) {
        serversByCatalog.set(server.catalogId, server);
      }
    }

    return serversByCatalog;
  }

  /**
   * Of `catalogIds`, the ones the caller can already reach at least one live
   * install of — their own personal install, an install shared with a team they
   * belong to, or an org-scoped install. This is the batch, pre-flight shape of
   * the same own → team → org precedence the runtime applies per call when it
   * picks which install serves a tool, so a catalog missing from the result is
   * one the caller would be prompted to connect at tool time.
   */
  static async getCatalogIdsWithAccessibleInstall(params: {
    userId: string;
    catalogIds: string[];
  }): Promise<Set<string>> {
    const { userId, catalogIds } = params;
    if (catalogIds.length === 0) return new Set();

    const accessibleServerIds =
      await McpServerModel.getAccessibleInstallIds(userId);
    if (accessibleServerIds.length === 0) return new Set();

    // Filtered by catalog in SQL and intersected with the caller's access in
    // memory, rather than sending every accessible install id as a bind
    // parameter — the caller's set grows with the organization, while the
    // catalogs asked about are only the ones an agent actually uses.
    const accessible = new Set(accessibleServerIds);
    const rows = await db
      .select({
        id: schema.mcpServersTable.id,
        catalogId: schema.mcpServersTable.catalogId,
      })
      .from(schema.mcpServersTable)
      .where(
        and(
          inArray(schema.mcpServersTable.catalogId, catalogIds),
          notDeleted(schema.mcpServersTable),
        ),
      );

    return new Set(
      rows.flatMap((row) =>
        row.catalogId && accessible.has(row.id) ? [row.catalogId] : [],
      ),
    );
  }

  /**
   * Validate that an MCP server can be connected to with given secretId
   */
  static async validateConnection(
    serverName: string,
    catalogId?: string,
    secretId?: string,
  ): Promise<{ isValid: boolean; errorMessage?: string }> {
    // Load secrets if secretId is provided
    let secrets: Record<string, unknown> = {};
    if (secretId) {
      const secretRecord = await secretManager().getSecret(secretId);
      if (secretRecord) {
        secrets = secretRecord.secret;
      }
    }

    // Check if we can connect using catalog info
    if (catalogId) {
      try {
        const catalogItem = await InternalMcpCatalogModel.findById(catalogId);

        if (catalogItem?.serverType === "remote") {
          // Use a temporary ID for validation (we don't have a real server ID yet)
          const tools = await mcpClient.connectAndGetTools({
            catalogItem,
            mcpServerId: "validation",
            secrets,
            secretId,
          });
          return {
            isValid: tools.length > 0,
            errorMessage: tools.length > 0 ? undefined : "No tools found",
          };
        }
      } catch (error) {
        logger.error(
          { err: error },
          `Validation failed for remote MCP server ${serverName}:`,
        );
        return { isValid: false, errorMessage: (error as Error).message };
      }
    }

    return { isValid: false, errorMessage: "No catalog ID provided" };
  }
  static async findByIdForAudit(
    id: string,
    organizationId: string,
  ): Promise<Record<string, unknown> | null> {
    // `mcp_server` has no direct `organization_id` column, so we infer org
    // membership through related rows. A snapshot is returned only when at
    // least one of these holds:
    //   - team-scoped: the team belongs to the org
    //   - personal / org-scoped with an owner: the owner is a member of the org
    //   - unowned + teamless: pre-existing system-owned rows that have no
    //     org linkage at all (matches the previous semantics so we don't
    //     regress legacy data or org-wide seeded servers).
    const [row] = await db
      .select({
        server: schema.mcpServersTable,
        catalogName: schema.internalMcpCatalogTable.name,
        catalogVersion: schema.internalMcpCatalogTable.version,
        catalogServerUrl: schema.internalMcpCatalogTable.serverUrl,
        catalogRequiresAuth: schema.internalMcpCatalogTable.requiresAuth,
        catalogLocalConfig: schema.internalMcpCatalogTable.localConfig,
        catalogOauthConfig: schema.internalMcpCatalogTable.oauthConfig,
        catalogUserConfig: schema.internalMcpCatalogTable.userConfig,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.mcpServersTable.ownerId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          eq(schema.mcpServersTable.id, id),
          or(
            eq(schema.teamsTable.organizationId, organizationId),
            isNotNull(schema.membersTable.id),
            and(
              isNull(schema.mcpServersTable.teamId),
              isNull(schema.mcpServersTable.ownerId),
            ),
          ),
        ),
      )
      .limit(1);

    if (!row) return null;
    const s = row.server;

    const localConfig = row.catalogLocalConfig;
    const transportType = localConfig?.transportType ?? "stdio";
    const envKeys = Array.isArray(localConfig?.environment)
      ? localConfig.environment.map((e) => e.key).sort()
      : [];
    const userConfigKeys = row.catalogUserConfig
      ? Object.keys(row.catalogUserConfig).sort()
      : [];

    return {
      id: s.id,
      name: s.name,
      catalogId: s.catalogId,
      catalogName: row.catalogName ?? null,
      catalogVersion: row.catalogVersion ?? null,
      serverType: s.serverType,
      scope: s.scope,
      ownerId: s.ownerId ?? null,
      teamId: s.teamId ?? null,
      transportType,
      serverUrl: row.catalogServerUrl ?? null,
      requiresAuth: row.catalogRequiresAuth ?? null,
      envKeys,
      userConfigKeys,
      hasOauthConfig: row.catalogOauthConfig !== null,
      hasSecret: Boolean(s.secretId),
      localInstallationStatus: s.localInstallationStatus,
      oauthRefreshError: s.oauthRefreshError ?? null,
      // Lifecycle fields so the soft-delete/restore diff is non-empty: a
      // (flag-only) restore flips deletedAt → null and reinstallRequired → true.
      deletedAt: s.deletedAt ? s.deletedAt.toISOString() : null,
      reinstallRequired: s.reinstallRequired,
      // SPDX-SnippetBegin
      // SPDX-SnippetCopyrightText: 2026 Archestra Inc.
      // SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
      hibernationMode: s.hibernationMode,
      // SPDX-SnippetEnd
      createdAt: s.createdAt.toISOString(),
    };
  }

  /**
   * Org-scoped listing of SOFT-DELETED installs, for the `status=deleted`
   * registry filter (a backend affordance for enumerating restorable ids).
   * Does NOT filter `notDeleted` — it is a deleted-only read. `mcp_server` has
   * no `organization_id` column, so org membership is inferred through the same
   * team/member join as {@link findDeletedByIdForOrganization}. App-backed
   * servers are excluded (managed on the Apps surface, like the active listing).
   */
  static async findDeletedForOrganization(
    organizationId: string,
  ): Promise<McpServer[]> {
    const rows = await db
      .select({
        server: schema.mcpServersTable,
        ownerEmail: schema.usersTable.email,
        catalogName: schema.internalMcpCatalogTable.name,
        teamName: schema.teamsTable.name,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpServersTable.ownerId, schema.usersTable.id),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .leftJoin(
        schema.teamsTable,
        eq(schema.mcpServersTable.teamId, schema.teamsTable.id),
      )
      .leftJoin(
        schema.membersTable,
        and(
          eq(schema.membersTable.userId, schema.mcpServersTable.ownerId),
          eq(schema.membersTable.organizationId, organizationId),
        ),
      )
      .where(
        and(
          isNotNull(schema.mcpServersTable.deletedAt),
          ne(schema.mcpServersTable.serverType, "app"),
          or(
            eq(schema.teamsTable.organizationId, organizationId),
            isNotNull(schema.membersTable.id),
            and(
              isNull(schema.mcpServersTable.teamId),
              isNull(schema.mcpServersTable.ownerId),
            ),
          ),
        ),
      )
      .orderBy(desc(schema.mcpServersTable.deletedAt));

    return rows.map((row) => ({
      ...row.server,
      ownerEmail: row.ownerEmail,
      catalogName: row.catalogName,
      teamDetails: row.server.teamId
        ? {
            teamId: row.server.teamId,
            name: row.teamName || "",
            createdAt: row.server.createdAt,
          }
        : null,
    }));
  }

  /**
   * Shared body of the personal-install purges: tear down the K8s deployment
   * for local installs, hard-delete each row, and delete its credential secret
   * through the secret manager (so Vault/BYOS-backed material is removed from
   * the backing store too). Best-effort per install — a wedged deployment or
   * secret must not block the rest of the purge.
   */
  private static async purgeInstallRows(
    userId: string,
    servers: {
      id: string;
      serverType: string | null;
      secretId: string | null;
    }[],
  ): Promise<string[]> {
    if (servers.length === 0) {
      return [];
    }

    const purgedIds: string[] = [];

    for (const server of servers) {
      // Tear the deployment (and its live K8s Secret) down before dropping the
      // row — `removeMcpServer` resolves the deployment through the DB row.
      if (server.serverType === "local") {
        try {
          await McpServerRuntimeManager.removeMcpServer(server.id);
        } catch (error) {
          logger.error(
            { err: error, userId, mcpServerId: server.id },
            "McpServerModel.purgeInstallRows: failed to tear down K8s deployment",
          );
        }
      }

      await McpServerModel.hardDelete(server.id);
      purgedIds.push(server.id);

      if (server.secretId) {
        try {
          await secretManager().deleteSecret(server.secretId);
        } catch (error) {
          // The install is already gone, so nothing points at this secret
          // anymore. Log the id loudly — it needs a manual sweep.
          logger.error(
            { err: error, userId, secretId: server.secretId },
            "McpServerModel.purgeInstallRows: failed to delete credential secret; it is now orphaned",
          );
        }
      }
    }

    logger.info(
      { userId, purgedCount: purgedIds.length },
      "McpServerModel.purgeInstallRows: purged personal MCP installs and their credentials",
    );

    return purgedIds;
  }
}

export default McpServerModel;
