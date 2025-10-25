import { GITHUB_MCP_SERVER_NAME } from "@shared";
import { eq, inArray, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import mcpClientService from "@/services/mcp-client";
import type {
  InsertMcpServer,
  McpServer,
  McpServerMetadata,
  UpdateMcpServer,
} from "@/types";
import McpServerTeamModel from "./mcp-server-team";

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
    const result = await db
      .delete(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
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
    /**
     * NOTE: this is just for demo purposes for right now.. should be removed once we have full support here..
     *
     * For GitHub MCP server, extract token from metadata and connect
     */
    if (mcpServer.name === GITHUB_MCP_SERVER_NAME && mcpServer.metadata) {
      const metadata = mcpServer.metadata;
      const githubToken = metadata.githubToken as string;

      if (githubToken) {
        try {
          const config = mcpClientService.createGitHubConfig(githubToken);
          const tools = await mcpClientService.connectAndGetTools(config);
          // Transform to ensure description is always a string
          return tools.map((tool) => ({
            name: tool.name,
            description: tool.description || `Tool: ${tool.name}`,
            inputSchema: tool.inputSchema,
          }));
        } catch (error) {
          console.error(`Failed to get tools from GitHub MCP server:`, error);
        }
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
   * Validate that an MCP server can be connected to with given metadata
   */
  static async validateConnection(
    serverName: string,
    metadata: McpServerMetadata,
  ): Promise<boolean> {
    if (serverName === GITHUB_MCP_SERVER_NAME) {
      const githubToken = metadata.githubToken as string;
      if (githubToken) {
        return await mcpClientService.validateGitHubConnection(githubToken);
      }
    }

    return false;
  }
}

export default McpServerModel;
