import { eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";

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
   * Get the list of tools provided by this MCP server
   * For now, this returns mock data. Eventually this will call the actual MCP client's tools/list
   */
  static getListedTools(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }> {
    // Mock MCP tools based on MCP specification
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
}

export default McpServerModel;
