import { eq, inArray, isNull } from "drizzle-orm";
import mcpClient from "@/clients/mcp-client";
import db, { schema } from "@/database";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import { secretManager } from "@/secretsmanager";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";
import AgentToolModel from "./agent-tool";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerTeamModel from "./mcp-server-team";
import McpServerUserModel from "./mcp-server-user";
import ToolModel from "./tool";

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const { teams, userId, ...serverData } = server;

    // For local servers, add a unique identifier to the name to avoid conflicts
    let mcpServerName = serverData.name;
    if (serverData.serverType === "local" && userId) {
      mcpServerName = `${serverData.name}-${userId}`;
    }

    // ownerId is part of serverData and will be inserted
    const [createdServer] = await db
      .insert(schema.mcpServersTable)
      .values({ ...serverData, name: mcpServerName })
      .returning();

    // Assign teams to the MCP server if provided
    if (teams && teams.length > 0) {
      await McpServerTeamModel.assignTeamsToMcpServer(createdServer.id, teams);
    }

    // Assign user to the MCP server if provided (personal auth)
    if (userId) {
      await McpServerUserModel.assignUserToMcpServer(createdServer.id, userId);
    }

    return {
      ...createdServer,
      teams: teams || [],
      users: userId ? [userId] : [],
    };
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
      .$dynamic();

    // Apply access control filtering for non-MCP server admins
    if (userId && !isMcpServerAdmin) {
      // Get MCP servers accessible through team membership and personal access in parallel
      const [teamAccessibleMcpServerIds, personalMcpServerIds] =
        await Promise.all([
          McpServerTeamModel.getUserAccessibleMcpServerIds(userId, false),
          McpServerUserModel.getUserPersonalMcpServerIds(userId),
        ]);

      // Combine both lists
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

    // Populate teams and user details for all MCP servers with bulk queries to avoid N+1
    const [userDetailsMap, teamDetailsMap] = await Promise.all([
      McpServerUserModel.getUserDetailsForMcpServers(serverIds),
      McpServerTeamModel.getTeamDetailsForMcpServers(serverIds),
    ]);

    // Build the servers with relations
    const serversWithRelations: McpServer[] = results.map((result) => {
      const userDetails = userDetailsMap.get(result.server.id) || [];
      const teamDetails = teamDetailsMap.get(result.server.id) || [];

      return {
        ...result.server,
        ownerEmail: result.ownerEmail,
        catalogName: result.catalogName,
        teams: teamDetails.map((t) => t.teamId),
        users: userDetails.map((u) => u.userId),
        userDetails,
        teamDetails,
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
        McpServerTeamModel.userHasMcpServerAccess(userId, id, false),
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
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpServersTable.ownerId, schema.usersTable.id),
      )
      .where(eq(schema.mcpServersTable.id, id));

    if (!result) {
      return null;
    }

    const [teamDetails, userDetails] = await Promise.all([
      McpServerTeamModel.getTeamDetailsForMcpServer(id),
      McpServerUserModel.getUserDetailsForMcpServer(id),
    ]);

    return {
      ...result.server,
      ownerEmail: result.ownerEmail,
      teams: teamDetails.map((t) => t.teamId),
      users: userDetails.map((u) => u.userId),
      userDetails,
      teamDetails,
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
    const { teams, ...serverData } = server;

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
      // If only updating teams, fetch the existing server
      const [existingServer] = await db
        .select()
        .from(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, id));

      if (!existingServer) {
        return null;
      }

      updatedServer = existingServer;
    }

    // Sync team assignments if teams is provided
    if (teams !== undefined) {
      await McpServerTeamModel.syncMcpServerTeams(id, teams);
    }

    // Fetch current teams
    const currentTeams = await McpServerTeamModel.getTeamsForMcpServer(id);

    return {
      ...updatedServer,
      teams: currentTeams,
    };
  }

  static async delete(id: string): Promise<boolean> {
    // First, get the MCP server to find its associated secret
    const mcpServer = await McpServerModel.findById(id);

    if (!mcpServer) {
      return false;
    }

    // For local servers, stop and remove the K8s pod
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
        logger.info(`Cleaned up K8s pod for MCP server: ${mcpServer.name}`);
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to clean up K8s pod for MCP server ${mcpServer.name}:`,
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
      await secretManager.deleteSecret(mcpServer.secretId);
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
      const secretRecord = await secretManager.getSecret(mcpServer.secretId);
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
      const secretRecord = await secretManager.getSecret(secretId);
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
