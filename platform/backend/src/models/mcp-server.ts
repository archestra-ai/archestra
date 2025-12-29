import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import mcpClient from "@/clients/mcp-client";
import db, { schema } from "@/database";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { computeSecretStorageType } from "@/secretmanager.utils";
import { secretManager } from "@/secretsmanager";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";
import AgentToolModel from "./agent-tool";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerUserModel from "./mcp-server-user";
import ToolModel from "./tool";

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const { userId, ...serverData } = server;

    // For local servers, add a unique identifier to the name to avoid conflicts
    // Use teamId for team installations, userId for personal installations
    let mcpServerName = serverData.name;
    if (serverData.serverType === "local") {
      if (serverData.teamId) {
        // Team installation: use teamId for unique deployment name
        mcpServerName = `${serverData.name}-${serverData.teamId}`;
      } else if (userId) {
        // Personal installation: use userId for unique deployment name
        mcpServerName = `${serverData.name}-${userId}`;
      }
    }

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
      .where(eq(schema.teamMembersTable.userId, userId));

    return mcpServers.map((s) => s.mcpServerId);
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
        ),
      )
      .limit(1);

    return result.length > 0;
  }

  static async findAll(
    userId?: string,
    isMcpServerAdmin?: boolean,
  ): Promise<McpServer[]> {
    let query = db
      .select({
        server: schema.mcpServersTable,
        ownerEmail: schema.usersTable.email,
        catalogName: schema.internalMcpCatalogTable.name,
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
      .$dynamic();

    // Apply access control filtering for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      // Get MCP servers accessible through:
      // 1. Team membership (servers assigned to user's teams)
      // 2. Personal access (user's own servers)
      const [teamAccessibleMcpServerIds, personalMcpServerIds] =
        await Promise.all([
          McpServerModel.getUserAccessibleMcpServerIdsByTeam(userId),
          McpServerUserModel.getUserPersonalMcpServerIds(userId),
        ]);

      // Combine all lists
      const accessibleMcpServerIds = [
        ...new Set([...teamAccessibleMcpServerIds, ...personalMcpServerIds]),
      ];

      if (accessibleMcpServerIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.mcpServersTable.id, accessibleMcpServerIds),
      );
    }

    const results = await query;

    const serverIds = results.map((result) => result.server.id);

    // Populate user details for all MCP servers with bulk query to avoid N+1
    const userDetailsMap =
      await McpServerUserModel.getUserDetailsForMcpServers(serverIds);

    // Build the servers with relations
    const serversWithRelations: McpServer[] = results.map((result) => {
      const userDetails = userDetailsMap.get(result.server.id) || [];

      // Build teamDetails from the joined team data
      const teamDetails = result.server.teamId
        ? {
            teamId: result.server.teamId,
            name: result.teamName || "",
            createdAt: result.server.createdAt, // Use server createdAt as team assignment time
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
        catalogName: result.catalogName,
        users: userDetails.map((u) => u.userId),
        userDetails,
        teamDetails,
        secretStorageType,
      };
    });

    return serversWithRelations;
  }

  static async findById(
    id: string,
    userId?: string,
    isMcpServerAdmin?: boolean,
  ): Promise<McpServer | null> {
    // Check access control for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      const [hasTeamAccess, hasPersonalAccess] = await Promise.all([
        McpServerModel.userHasMcpServerAccessByTeam(userId, id),
        McpServerUserModel.userHasPersonalMcpServerAccess(userId, id),
      ]);

      if (!hasTeamAccess && !hasPersonalAccess) {
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

  static async findByCatalogId(catalogId: string): Promise<McpServer[]> {
    return await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.catalogId, catalogId));
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

    // For local servers, stop and remove the K8s deployment
    if (mcpServer.serverType === "local") {
      // Clean up agent_tools that use this server as execution source
      // Must be done before deletion to ensure agents do not retain unusable tool assignments; FK constraint would only null out the reference, not remove the assignment
      try {
        const deletedAgentTools =
          await AgentToolModel.deleteByExecutionSourceMcpServerId(id);
        if (deletedAgentTools > 0) {
          logger.info(
            `Deleted ${deletedAgentTools} agent tool assignments for local MCP server: ${mcpServer.name}`,
          );
        }
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to clean up agent tools for MCP server ${mcpServer.name}:`,
        );
        // Continue with deletion even if agent tool cleanup fails
      }

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
      });

      // Transform to ensure description is always a string
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description || `Tool: ${tool.name}`,
        inputSchema: tool.inputSchema,
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
   * Validate that an MCP server can be connected to with given secretId
   */
  static async validateConnection(
    serverName: string,
    catalogId?: string,
    secretId?: string,
  ): Promise<boolean> {
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
          });
          return tools.length > 0;
        }
      } catch (error) {
        logger.error(
          { err: error },
          `Validation failed for remote MCP server ${serverName}:`,
        );
        return false;
      }
    }

    return false;
  }
}

export default McpServerModel;
