import { and, count, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertMemoryItem, MemoryItem } from "@/types";

class MemoryItemModel {
  static async findByUser(params: {
    organizationId: string;
    userId: string;
    namespace?: string;
    limit?: number;
  }): Promise<MemoryItem[]> {
    const conditions = [
      eq(schema.memoryItemsTable.organizationId, params.organizationId),
      eq(schema.memoryItemsTable.userId, params.userId),
    ];

    if (params.namespace !== undefined) {
      conditions.push(
        eq(schema.memoryItemsTable.namespace, params.namespace),
      );
    }

    let query = db
      .select()
      .from(schema.memoryItemsTable)
      .where(and(...conditions))
      .orderBy(desc(schema.memoryItemsTable.updatedAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }

    return await query;
  }

  static async countByUser(params: {
    organizationId: string;
    userId: string;
    namespace?: string;
  }): Promise<number> {
    const conditions = [
      eq(schema.memoryItemsTable.organizationId, params.organizationId),
      eq(schema.memoryItemsTable.userId, params.userId),
    ];

    if (params.namespace !== undefined) {
      conditions.push(
        eq(schema.memoryItemsTable.namespace, params.namespace),
      );
    }

    const [result] = await db
      .select({ count: count() })
      .from(schema.memoryItemsTable)
      .where(and(...conditions));

    return result?.count ?? 0;
  }

  static async findById(id: string): Promise<MemoryItem | null> {
    const [result] = await db
      .select()
      .from(schema.memoryItemsTable)
      .where(eq(schema.memoryItemsTable.id, id));

    return result ?? null;
  }

  static async create(data: InsertMemoryItem): Promise<MemoryItem> {
    const [result] = await db
      .insert(schema.memoryItemsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: { content?: string; namespace?: string },
  ): Promise<MemoryItem | null> {
    const [result] = await db
      .update(schema.memoryItemsTable)
      .set(data)
      .where(eq(schema.memoryItemsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const rows = await db
      .delete(schema.memoryItemsTable)
      .where(eq(schema.memoryItemsTable.id, id))
      .returning({ id: schema.memoryItemsTable.id });

    return rows.length > 0;
  }
}

export default MemoryItemModel;
