import { GITHUB_MCP_SERVER_NAME } from "@shared";
import { eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import mcpClientService from "@/services/mcp-client";
import type {
  InsertMcpServer,
  McpServer,
  McpServerMetadata,
  UpdateMcpServer,
} from "@/types";

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const [createdServer] = await db
      .insert(schema.mcpServersTable)
      .values(server)
      .returning();

    return createdServer;
  }

  static async findAll(): Promise<McpServer[]> {
    return await db.select().from(schema.mcpServersTable);
  }

  static async findById(id: string): Promise<McpServer | null> {
    const [server] = await db
      .select()
      .from(schema.mcpServersTable)
      .where(eq(schema.mcpServersTable.id, id));

    return server || null;
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
    const [updatedServer] = await db
      .update(schema.mcpServersTable)
      .set(server)
      .where(eq(schema.mcpServersTable.id, id))
      .returning();

    return updatedServer || null;
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
