import { desc, eq, ilike, inArray, or } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertInternalMcpCatalog,
  InternalMcpCatalog,
  UpdateInternalMcpCatalog,
} from "@/types";
import McpServerModel from "./mcp-server";

class InternalMcpCatalogModel {
  static async create(
    catalogItem: InsertInternalMcpCatalog,
  ): Promise<InternalMcpCatalog> {
    const [createdItem] = await db
      .insert(schema.internalMcpCatalogTable)
      .values(catalogItem)
      .returning();

    return createdItem;
  }

  static async findAll(): Promise<InternalMcpCatalog[]> {
    return await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .orderBy(desc(schema.internalMcpCatalogTable.createdAt));
  }

  static async searchByQuery(query: string): Promise<InternalMcpCatalog[]> {
    return await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(
        or(
          ilike(schema.internalMcpCatalogTable.name, `%${query}%`),
          ilike(schema.internalMcpCatalogTable.description, `%${query}%`),
        ),
      );
  }

  static async findById(id: string): Promise<InternalMcpCatalog | null> {
    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    return catalogItem || null;
  }

  /**
   * Batch fetch multiple catalog items by IDs.
   * Returns a Map of catalog ID to catalog item.
   */
  static async getByIds(
    ids: string[],
  ): Promise<Map<string, InternalMcpCatalog>> {
    if (ids.length === 0) {
      return new Map();
    }

    const catalogItems = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(inArray(schema.internalMcpCatalogTable.id, ids));

    return new Map(catalogItems.map((item) => [item.id, item]));
  }

  static async findByName(name: string): Promise<InternalMcpCatalog | null> {
    const [catalogItem] = await db
      .select()
      .from(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.name, name));

    return catalogItem || null;
  }

  static async update(
    id: string,
    catalogItem: Partial<UpdateInternalMcpCatalog>,
  ): Promise<InternalMcpCatalog | null> {
    const [updatedItem] = await db
      .update(schema.internalMcpCatalogTable)
      .set(catalogItem)
      .where(eq(schema.internalMcpCatalogTable.id, id))
      .returning();

    return updatedItem || null;
  }

  static async delete(id: string): Promise<boolean> {
    // First, find all servers associated with this catalog item
    const servers = await McpServerModel.findByCatalogId(id);

    // Delete each server (which will cascade to tools)
    for (const server of servers) {
      await McpServerModel.delete(server.id);
    }

    // Then delete the catalog entry itself
    const result = await db
      .delete(schema.internalMcpCatalogTable)
      .where(eq(schema.internalMcpCatalogTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default InternalMcpCatalogModel;
