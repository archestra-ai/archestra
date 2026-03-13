import { count, desc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertKnowledgeBase,
  KnowledgeBase,
  UpdateKnowledgeBase,
} from "@/types";

class KnowledgeBaseModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeBase[]> {
    let query = db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(
        eq(schema.knowledgeBasesTable.organizationId, params.organizationId),
      )
      .orderBy(desc(schema.knowledgeBasesTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findById(id: string): Promise<KnowledgeBase | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(eq(schema.knowledgeBasesTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KnowledgeBase[]> {
    if (ids.length === 0) return [];
    return await db
      .select()
      .from(schema.knowledgeBasesTable)
      .where(inArray(schema.knowledgeBasesTable.id, ids));
  }

  static async create(data: InsertKnowledgeBase): Promise<KnowledgeBase> {
    const [result] = await db
      .insert(schema.knowledgeBasesTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBase>,
  ): Promise<KnowledgeBase | null> {
    const [result] = await db
      .update(schema.knowledgeBasesTable)
      .set(data)
      .where(eq(schema.knowledgeBasesTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.knowledgeBasesTable)
      .where(eq(schema.knowledgeBasesTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  static async countByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBasesTable)
      .where(eq(schema.knowledgeBasesTable.organizationId, organizationId));

    return result?.count ?? 0;
  }
}

export default KnowledgeBaseModel;
