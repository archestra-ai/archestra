import { and, count, desc, eq } from "drizzle-orm";
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

  static async findByOrgAndSeededFromEnv(
    organizationId: string,
  ): Promise<KnowledgeGraph | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeGraphsTable)
      .where(
        and(
          eq(schema.knowledgeGraphsTable.organizationId, organizationId),
          eq(schema.knowledgeGraphsTable.seededFromEnv, true),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async seedFromEnv(params: {
    organizationId: string;
    name: string;
    provider: string;
    config: Record<string, unknown>;
  }): Promise<KnowledgeGraph> {
    const existing = await KnowledgeGraphModel.findByOrgAndSeededFromEnv(
      params.organizationId,
    );

    if (existing) {
      const updated = await KnowledgeGraphModel.update(existing.id, {
        config: params.config,
      });
      return updated ?? existing;
    }

    return await KnowledgeGraphModel.create({
      organizationId: params.organizationId,
      name: params.name,
      provider: params.provider,
      config: params.config,
      seededFromEnv: true,
    });
  }
}

export default KnowledgeGraphModel;
