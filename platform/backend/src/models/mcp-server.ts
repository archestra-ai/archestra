import { eq, inArray, isNull } from "drizzle-orm";
import mcpClient from "@/clients/mcp-client";
import config from "@/config";
import db, { schema } from "@/database";
import logger from "@/logging";
import { McpServerRuntimeManager } from "@/mcp-server-runtime";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerTeamModel from "./mcp-server-team";
import McpServerUserModel from "./mcp-server-user";
import SecretModel from "./secret";
import ToolModel from "./tool";

// Get the API base URL from config
const API_BASE_URL =
  process.env.ARCHESTRA_API_BASE_URL || `http://localhost:${config.api.port}`;

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const { teams, userId, ...serverData } = server;

    // For local servers, add a unique identifier to the name to avoid conflicts
    let mcpServerName = serverData.name;
    if (serverData.serverType === "local") {
      if (serverData.authType === "personal" && userId) {
        mcpServerName = `${serverData.name}-${userId}`;
      } else if (serverData.authType === "team") {
        mcpServerName = `${serverData.name}-team-${serverData.ownerId}`;
      }
    }

    // ownerId and authType are part of serverData and will be inserted
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
    isAdmin?: boolean,
  ): Promise<McpServer[]> {
    let query = db
      .select({
        server: schema.mcpServersTable,
        ownerEmail: schema.usersTable.email,
      })
      .from(schema.mcpServersTable)
      .leftJoin(
        schema.usersTable,
        eq(schema.mcpServersTable.ownerId, schema.usersTable.id),
      )
      .$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      // Get MCP servers accessible through team membership
      const teamAccessibleMcpServerIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(userId, false);

      // Get MCP servers with personal access
      const personalMcpServerIds =
        await McpServerUserModel.getUserPersonalMcpServerIds(userId);

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

    // Populate teams and user details for each MCP server
    const serversWithRelations: McpServer[] = await Promise.all(
      results.map(async (result) => {
        const userDetails = await McpServerUserModel.getUserDetailsForMcpServer(
          result.server.id,
        );
        const teamDetails = await McpServerTeamModel.getTeamDetailsForMcpServer(
          result.server.id,
        );
        return {
          ...result.server,
          ownerEmail: result.ownerEmail,
          teams: teamDetails.map((t) => t.teamId),
          users: userDetails.map((u) => u.userId),
          userDetails,
          teamDetails,
        };
      }),
    );

    return serversWithRelations;
  }

  static async findById(
    id: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<McpServer | null> {
    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasTeamAccess = await McpServerTeamModel.userHasMcpServerAccess(
        userId,
        id,
        false,
      );
      const hasPersonalAccess =
        await McpServerUserModel.userHasPersonalMcpServerAccess(userId, id);

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

    const teamDetails = await McpServerTeamModel.getTeamDetailsForMcpServer(id);
    const userDetails = await McpServerUserModel.getUserDetailsForMcpServer(id);

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
      await SecretModel.delete(mcpServer.secretId);
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

    // Load secrets if secretId is present
    let secrets: Record<string, unknown> = {};
    if (mcpServer.secretId) {
      const secretRecord = await SecretModel.findById(mcpServer.secretId);
      if (secretRecord) {
        secrets = secretRecord.secret;
      }
    }

    /**
     * For remote servers, connect using the server URL and secrets
     */
    if (catalogItem?.serverType === "remote" && catalogItem.serverUrl) {
      try {
        const config = mcpClient.createServerConfig({
          name: mcpServer.name,
          url: catalogItem.serverUrl,
          secrets,
        });
        const tools = await mcpClient.connectAndGetTools(config);
        // Transform to ensure description is always a string
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema,
        }));
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to get tools from remote MCP server ${mcpServer.name}:`,
        );
        throw error;
      }
    }

    /**
     * For local servers, check transport type and use appropriate endpoint
     */
    if (catalogItem?.serverType === "local") {
      try {
        // Check if this is a streamable-http server
        const usesStreamableHttp =
          await McpServerRuntimeManager.usesStreamableHttp(mcpServer.id);

        let url: string;
        if (usesStreamableHttp) {
          // Use the HTTP endpoint URL for streamable-http servers
          const httpEndpointUrl = McpServerRuntimeManager.getHttpEndpointUrl(
            mcpServer.id,
          );
          if (!httpEndpointUrl) {
            throw new Error(
              `No HTTP endpoint URL found for streamable-http server ${mcpServer.name}`,
            );
          }
          url = httpEndpointUrl;
        } else {
          // Use the MCP proxy endpoint for stdio servers
          url = `${API_BASE_URL}/mcp_proxy/${mcpServer.id}`;
        }

        const config = mcpClient.createServerConfig({
          name: mcpServer.name,
          url,
          secrets, // Local servers might still use secrets for API keys etc.
        });

        logger.warn(
          `Attempting to get tools from local MCP server ${mcpServer.name} with config ${JSON.stringify(config)}`,
        );

        const tools = await mcpClient.connectAndGetTools(config);
        // Transform to ensure description is always a string
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema,
        }));
      } catch (error) {
        logger.error(
          { err: error },
          `Failed to get tools from local MCP server ${mcpServer.name}:`,
        );
        throw error;
      }
    }

    /**
     * For other/unknown servers, return empty array
     */
    return [];
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
      const secretRecord = await SecretModel.findById(secretId);
      if (secretRecord) {
        secrets = secretRecord.secret;
      }
    }

    // For other remote servers, check if we can connect using catalog info
    if (catalogId) {
      try {
        const catalogItem = await InternalMcpCatalogModel.findById(catalogId);

        if (catalogItem?.serverType === "remote" && catalogItem.serverUrl) {
          const config = mcpClient.createServerConfig({
            name: serverName,
            url: catalogItem.serverUrl,
            secrets,
          });
          const tools = await mcpClient.connectAndGetTools(config);
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
