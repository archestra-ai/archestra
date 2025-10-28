import { GITHUB_MCP_SERVER_NAME } from "@shared";
import { eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import mcpClientService from "@/services/mcp-client";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";
import McpServerTeamModel from "./mcp-server-team";
import SecretModel from "./secret";

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const { teams, ...serverData } = server;

    const [createdServer] = await db
      .insert(schema.mcpServersTable)
      .values(serverData)
      .returning();

    // Assign teams to the MCP server if provided
    if (teams && teams.length > 0) {
      await McpServerTeamModel.assignTeamsToMcpServer(createdServer.id, teams);
    }

    return {
      ...createdServer,
      teams: teams || [],
    };
  }

  static async findAll(
    userId?: string,
    isAdmin?: boolean,
  ): Promise<McpServer[]> {
    let query = db.select().from(schema.mcpServersTable).$dynamic();

    // Apply access control filtering for non-admins
    if (userId && !isAdmin) {
      const accessibleMcpServerIds =
        await McpServerTeamModel.getUserAccessibleMcpServerIds(userId, false);

      if (accessibleMcpServerIds.length === 0) {
        return [];
      }

      query = query.where(
        inArray(schema.mcpServersTable.id, accessibleMcpServerIds),
      );
    }

    const servers = await query;

    // Populate teams for each MCP server
    const serversWithTeams: McpServer[] = await Promise.all(
      servers.map(async (server) => ({
        ...server,
        teams: await McpServerTeamModel.getTeamsForMcpServer(server.id),
      })),
    );

    return serversWithTeams;
  }

  static async findById(
    id: string,
    userId?: string,
    isAdmin?: boolean,
  ): Promise<McpServer | null> {
    // Check access control for non-admins
    if (userId && !isAdmin) {
      const hasAccess = await McpServerTeamModel.userHasMcpServerAccess(
        userId,
        id,
        false,
      );
      if (!hasAccess) {
        return null;
      }
    }

    const [server] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));

    if (!server) {
      return null;
    }

    const teams = await McpServerTeamModel.getTeamsForMcpServer(id);

    return {
      ...server,
      teams,
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

    // Delete the MCP server
    const result = await db
      .delete(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));

    const deleted = result.rowCount !== null && result.rowCount > 0;

    // If the MCP server was deleted and it had an associated secret, delete the secret
    if (deleted && mcpServer.secretId) {
      await SecretModel.delete(mcpServer.secretId);
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
      const { default: InternalMcpCatalogModel } = await import(
        "./internal-mcp-catalog"
      );
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
        const config = mcpClientService.createRemoteServerConfig({
          name: mcpServer.name,
          url: catalogItem.serverUrl,
          secrets,
        });
        const tools = await mcpClientService.connectAndGetTools(config);
        // Transform to ensure description is always a string
        return tools.map((tool) => ({
          name: tool.name,
          description: tool.description || `Tool: ${tool.name}`,
          inputSchema: tool.inputSchema,
        }));
      } catch (error) {
        console.error(
          `Failed to get tools from remote MCP server ${mcpServer.name}:`,
          error,
        );
        throw error;
      }
    }

    /**
     * For other/unknown servers, return mock data
     *
     * Soon we will add support for all mcp servers here...
     */
    return [
      {
        name: "read_file",
        description:
          "Read the complete contents of a file from the file system",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the file to read",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "list_directory",
        description: "List all files and directories in a given path",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Path to the directory to list",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "search_files",
        description: "Search for files matching a pattern",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Glob pattern to match files",
            },
            base_path: {
              type: "string",
              description: "Base directory to search from",
            },
          },
          required: ["pattern"],
        },
      },
    ];
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
        const { default: InternalMcpCatalogModel } = await import(
          "./internal-mcp-catalog"
        );
        const catalogItem = await InternalMcpCatalogModel.findById(catalogId);

        if (catalogItem?.serverType === "remote" && catalogItem.serverUrl) {
          const config = mcpClientService.createRemoteServerConfig({
            name: serverName,
            url: catalogItem.serverUrl,
            secrets,
          });
          const tools = await mcpClientService.connectAndGetTools(config);
          return tools.length > 0;
        }
      } catch (error) {
        console.error(
          `Validation failed for remote MCP server ${serverName}:`,
          error,
        );
        return false;
      }
    }

    return false;
  }
}

export default McpServerModel;
