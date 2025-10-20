import { eq, isNull } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMcpServer, McpServer, UpdateMcpServer } from "@/types";

class McpServerModel {
  static async create(server: InsertMcpServer): Promise<McpServer> {
    const [createdServer] = await db
      .insert(schema.mcpServerTable)
      .values(server)
      .returning();

    return createdServer;
  }

  static async findAll(): Promise<McpServer[]> {
    return await db.select().from(schema.mcpServerTable);
  }

  static async findById(id: string): Promise<McpServer | null> {
    const [server] = await db
      .select()
      .from(schema.mcpServerTable)
      .where(eq(schema.mcpServerTable.id, id));

    return server || null;
  }

  static async findByCatalogId(catalogId: string): Promise<McpServer[]> {
    return await db
      .select()
      .from(schema.mcpServerTable)
      .where(eq(schema.mcpServerTable.catalogId, catalogId));
  }

  static async findCustomServers(): Promise<McpServer[]> {
    // Find servers that don't have a catalogId (custom installations)
    return await db
      .select()
      .from(schema.mcpServerTable)
      .where(isNull(schema.mcpServerTable.catalogId));
  }

  static async update(
    id: string,
    server: Partial<UpdateMcpServer>,
  ): Promise<McpServer | null> {
    const [updatedServer] = await db
      .update(schema.mcpServerTable)
      .set(server)
      .where(eq(schema.mcpServerTable.id, id))
      .returning();

    return updatedServer || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.mcpServerTable)
      .where(eq(schema.mcpServerTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpServerModel;
