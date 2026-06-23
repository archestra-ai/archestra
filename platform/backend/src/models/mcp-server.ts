import { ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import {
  and,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import mcpClient from "@/clients/mcp-client";
import db, { schema } from "@/database";
import { McpServerRuntimeManager } from "@/k8s/mcp-server-runtime";
import logger from "@/logging";
import { secretManager } from "@/secrets-manager";
import { computeSecretStorageType } from "@/secrets-manager/utils";
import type {
  InsertMcpServer,
  McpServer,
  ResourceVisibilityScope,
  UpdateMcpServer,
} from "@/types";
import AgentToolModel from "./agent-tool";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpHttpSessionModel from "./mcp-http-session";
import McpServerUserModel from "./mcp-server-user";
import ToolModel from "./tool";

// Alias for users table to avoid conflict with the owner LEFT JOIN
const assignedUsersTable = alias(schema.usersTable, "assigned_users");

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

  static async create(server: InsertMcpServer): Promise<McpServer> {
    const { userId, ...serverData } = server;

    const mcpServerName = McpServerModel.constructServerName({
      baseName: serverData.name,
      serverType: serverData.serverType,
      scope: serverData.scope ?? "personal",
      ownerId: userId ?? null,
      teamId: serverData.teamId ?? null,
    });

    // ownerId is part of serverData and will be inserted
    const [createdServer] = await db
      .insert(schema.mcpServersTable)
      .values({ ...serverData, name: mcpServerName })
      .returning();

    // Assign user to the MCP server if provided (personal auth)
    if (userId) {
      await McpServerUserModel.assignUserToMcpServer(createdServer.id, userId);
    }

    return {
      ...createdServer,
      users: userId ? [userId] : [],
    };
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
        ),
      );

    return mcpServers.map((s) => s.mcpServerId);
  }

  /**
   * Get IDs of org-scoped MCP servers visible to every member of the
   * organization.
   */
  private static async getOrgScopedMcpServerIds(): Promise<string[]> {
    const rows = await db
      .select({ id: schema.mcpServersTable.id })
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.scope, "org"));
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
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  static async findAll(
    userId?: string,
    isMcpServerAdmin?: boolean,
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

    // Apply access control filtering for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      // Get MCP servers accessible through:
      // 1. Team membership (servers assigned to user's teams)
      // 2. Personal access (user's own servers)
      // 3. Org-scoped servers (visible to all org members)
      const [
        teamAccessibleMcpServerIds,
        personalMcpServerIds,
        orgScopedMcpServerIds,
      ] = await Promise.all([
        McpServerModel.getUserAccessibleMcpServerIdsByTeam(userId),
        McpServerUserModel.getUserPersonalMcpServerIds(userId),
        McpServerModel.getOrgScopedMcpServerIds(),
      ]);

      // Combine all lists
      const accessibleMcpServerIds = [
        ...new Set([
          ...teamAccessibleMcpServerIds,
          ...personalMcpServerIds,
          ...orgScopedMcpServerIds,
        ]),
      ];

      if (accessibleMcpServerIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.mcpServersTable.id, accessibleMcpServerIds),
      );
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

    return Array.from(serversMap.values());
  }

  /**
   * Installed servers the caller may view that provide an MCP Apps UI — a
   * discovered tool whose `_meta.ui.resourceUri` (or legacy `ui/resourceUri`)
   * names a `ui://` resource. Drives the external half of the unified Apps
   * listing (mcp-apps.md FR-27). The built-in Archestra catalog is excluded so
   * its own UI tools never masquerade as external apps. One entry per installed
   * server; the primary resource is the lowest-named UI tool's uri. Access
   * filtering mirrors {@link findAll}.
   */
  static async findUiCapableForCaller(params: {
    userId: string;
    isMcpServerAdmin: boolean;
    search?: string;
  }): Promise<
    Array<{
      mcpServerId: string;
      name: string;
      description: string | null;
      scope: ResourceVisibilityScope;
      ownerId: string | null;
      resourceUri: string;
    }>
  > {
    const { userId, isMcpServerAdmin, search } = params;

    let accessibleIds: string[] | null = null;
    if (!isMcpServerAdmin) {
      const [teamIds, personalIds, orgIds] = await Promise.all([
        McpServerModel.getUserAccessibleMcpServerIdsByTeam(userId),
        McpServerUserModel.getUserPersonalMcpServerIds(userId),
        McpServerModel.getOrgScopedMcpServerIds(),
      ]);
      accessibleIds = [...new Set([...teamIds, ...personalIds, ...orgIds])];
      if (accessibleIds.length === 0) return [];
    }

    const searchTerm = search?.trim();
    // An MCP App UI resource must use the ui:// scheme; a tool whose
    // _meta.ui.resourceUri is some other URI is not an app and must not surface
    // here. Canonical key first, then the legacy flat key.
    const toolMeta = schema.toolsTable.meta;
    const uiResourceUri = sql<string | null>`coalesce(
      case when ${toolMeta}->'_meta'->'ui'->>'resourceUri' like 'ui://%' then ${toolMeta}->'_meta'->'ui'->>'resourceUri' end,
      case when ${toolMeta}->'_meta'->>'ui/resourceUri' like 'ui://%' then ${toolMeta}->'_meta'->>'ui/resourceUri' end
    )`;
    const rows = await db
      .select({
        mcpServerId: schema.mcpServersTable.id,
        serverName: schema.mcpServersTable.name,
        scope: schema.mcpServersTable.scope,
        ownerId: schema.mcpServersTable.ownerId,
        catalogName: schema.internalMcpCatalogTable.name,
        catalogDescription: schema.internalMcpCatalogTable.description,
        toolName: schema.toolsTable.name,
        resourceUri: uiResourceUri,
      })
      .from(schema.mcpServersTable)
      .innerJoin(
        schema.toolsTable,
        eq(schema.toolsTable.catalogId, schema.mcpServersTable.catalogId),
      )
      .leftJoin(
        schema.internalMcpCatalogTable,
        eq(schema.mcpServersTable.catalogId, schema.internalMcpCatalogTable.id),
      )
      .where(
        and(
          ne(schema.mcpServersTable.catalogId, ARCHESTRA_MCP_CATALOG_ID),
          sql`${uiResourceUri} IS NOT NULL`,
          accessibleIds
            ? inArray(schema.mcpServersTable.id, accessibleIds)
            : undefined,
          searchTerm
            ? or(
                ilike(schema.internalMcpCatalogTable.name, `%${searchTerm}%`),
                ilike(
                  schema.internalMcpCatalogTable.description,
                  `%${searchTerm}%`,
                ),
                ilike(schema.mcpServersTable.name, `%${searchTerm}%`),
              )
            : undefined,
        ),
      );

    // One entry per server; keep the lowest-named UI tool's resource as primary.
    const byServer = new Map<
      string,
      {
        mcpServerId: string;
        name: string;
        description: string | null;
        scope: ResourceVisibilityScope;
        ownerId: string | null;
        resourceUri: string;
        primaryToolName: string;
      }
    >();
    for (const row of rows) {
      if (!row.resourceUri) continue;
      const existing = byServer.get(row.mcpServerId);
      if (!existing || row.toolName < existing.primaryToolName) {
        byServer.set(row.mcpServerId, {
          mcpServerId: row.mcpServerId,
          name: row.catalogName ?? row.serverName,
          description: row.catalogDescription ?? null,
          scope: row.scope,
          ownerId: row.ownerId,
          resourceUri: row.resourceUri,
          primaryToolName: row.toolName,
        });
      }
    }
    return Array.from(byServer.values()).map((entry) => ({
      mcpServerId: entry.mcpServerId,
      name: entry.name,
      description: entry.description,
      scope: entry.scope,
      ownerId: entry.ownerId,
      resourceUri: entry.resourceUri,
    }));
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
      .where(eq(schema.mcpServersTable.id, id));

    if (!result) {
      return null;
    }

    const userDetails = await McpServerUserModel.getUserDetailsForMcpServer(id);

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
      .where(inArray(schema.mcpServersTable.id, ids));
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

  static async findByCatalogId(catalogId: string): Promise<McpServer[]> {
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalogId));
  }

  static async findByCatalogIds(catalogIds: string[]): Promise<McpServer[]> {
    if (catalogIds.length === 0) return [];
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(inArray(schema.mcpServersTable.catalogId, catalogIds));
  }

  static async findCustomServers(): Promise<McpServer[]> {
    // Find servers that don't have a catalogId (custom installations)
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(isNull(schema.mcpServersTable.catalogId));
  }

  static async update(
    id: string,
    server: Partial<UpdateMcpServer>,
  ): Promise<McpServer | null> {
    const serverData = server;

    let updatedServer: McpServer | undefined;

    // Only update server table if there are fields to update
    if (Object.keys(serverData).length > 0) {
      [updatedServer] = await db
        .update(schema.mcpServersTable)
        .set(serverData)
        .where(eq(schema.mcpServersTable.id, id))
        .returning();

      if (!updatedServer) {
        return null;
      }
    } else {
      // No fields to update, fetch the existing server
      const [existingServer] = await db
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

  static async delete(id: string): Promise<boolean> {
    // First, get the MCP server to find its associated secret
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

    // Clean up agent_tools that reference this server
    // Must be done before deletion to ensure agents do not retain unusable tool assignments
    // FK constraint would only null out the reference, not remove the assignment
    try {
      let deletedAgentTools = 0;
      if (mcpServer.serverType === "local") {
        deletedAgentTools =
          await AgentToolModel.deleteByExecutionSourceMcpServerId(id);
      } else {
        deletedAgentTools =
          await AgentToolModel.deleteByCredentialSourceMcpServerId(id);
      }
      if (deletedAgentTools > 0) {
        logger.info(
          `Deleted ${deletedAgentTools} agent tool assignments for MCP server: ${mcpServer.name}`,
        );
      }
    } catch (error) {
      logger.error(
        { err: error },
        `Failed to clean up agent tools for MCP server ${mcpServer.name}:`,
      );
      // Continue with deletion even if agent tool cleanup fails
    }

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

    // Delete the MCP server from database
    logger.info(`Deleting MCP server: ${mcpServer.name} with id: ${id}`);
    const result = await db
      .delete(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));

    const deleted = result.rowCount !== null && result.rowCount > 0;

    // If the MCP server was deleted and it had an associated secret, delete the secret
    if (deleted && mcpServer.secretId) {
      await secretManager().deleteSecret(mcpServer.secretId);
    }

    // If the MCP server was deleted and had a catalogId, check if this was the last installation
    // If so, clean up all tools for this catalog
    if (deleted && mcpServer.catalogId) {
      try {
        // Check if any other servers exist for this catalog
        const remainingServers = await McpServerModel.findByCatalogId(
          mcpServer.catalogId,
        );

        if (remainingServers.length === 0) {
          // No more servers for this catalog, delete all tools
          const deletedToolsCount = await ToolModel.deleteByCatalogId(
            mcpServer.catalogId,
          );
          logger.info(
            `Deleted ${deletedToolsCount} tools for catalog ${mcpServer.catalogId} (last installation removed)`,
          );
        }
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to clean up tools for catalog ${mcpServer.catalogId}:`,
        );
        // Don't fail the deletion if tool cleanup fails
      }
    }

    return deleted;
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
      createdAt: s.createdAt.toISOString(),
    };
  }
}

export default McpServerModel;
