import { count, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertKnowledgeGraph,
  KnowledgeGraph,
  UpdateKnowledgeGraph,
} from "@/types";

class KnowledgeGraphModel {
  static async findByOrganization(params: {
    organizationId: string;
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeGraph[]> {
    let query = db
      .select()
      .from(schema.knowledgeGraphsTable)
      .where(
        eq(schema.knowledgeGraphsTable.organizationId, params.organizationId),
      )
      .orderBy(desc(schema.knowledgeGraphsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findById(id: string): Promise<KnowledgeGraph | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeGraphsTable)
      .where(eq(schema.knowledgeGraphsTable.id, id));

    return result ?? null;
  }

  static async create(data: InsertKnowledgeGraph): Promise<KnowledgeGraph> {
    const [result] = await db
      .insert(schema.knowledgeGraphsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeGraph>,
  ): Promise<KnowledgeGraph | null> {
    const [result] = await db
      .update(schema.knowledgeGraphsTable)
      .set(data)
      .where(eq(schema.knowledgeGraphsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.knowledgeGraphsTable)
      .where(eq(schema.knowledgeGraphsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  static async countByOrganization(organizationId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeGraphsTable)
      .where(eq(schema.knowledgeGraphsTable.organizationId, organizationId));

    return result?.count ?? 0;
  }
}

export default KnowledgeGraphModel;
