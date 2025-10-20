import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMcpCatalog, McpCatalog, UpdateMcpCatalog } from "@/types";

class McpCatalogModel {
  static async create(catalogItem: InsertMcpCatalog): Promise<McpCatalog> {
    const [createdItem] = await db
      .insert(schema.mcpCatalogTable)
      .values(catalogItem)
      .returning();

    return createdItem;
  }

  static async findAll(): Promise<McpCatalog[]> {
    return await db.select().from(schema.mcpCatalogTable);
  }

  static async findById(id: string): Promise<McpCatalog | null> {
    const [catalogItem] = await db
      .select()
      .from(schema.mcpCatalogTable)
      .where(eq(schema.mcpCatalogTable.id, id));

    return catalogItem || null;
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateMcpCatalog>,
  ): Promise<McpCatalog | null> {
    const [updatedItem] = await db
      .update(schema.mcpCatalogTable)
      .set(catalogItem)
      .where(eq(schema.mcpCatalogTable.id, id))
      .returning();

    return updatedItem || null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.mcpCatalogTable)
      .where(eq(schema.mcpCatalogTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default McpCatalogModel;
