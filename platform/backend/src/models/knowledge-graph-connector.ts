import { count, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertKnowledgeGraphConnector,
  KnowledgeGraphConnector,
  UpdateKnowledgeGraphConnector,
} from "@/types";

class KnowledgeGraphConnectorModel {
  static async findByKnowledgeGraph(params: {
    knowledgeGraphId: string;
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeGraphConnector[]> {
    let query = db
      .select()
      .from(schema.knowledgeGraphConnectorsTable)
      .where(
        eq(
          schema.knowledgeGraphConnectorsTable.knowledgeGraphId,
          params.knowledgeGraphId,
        ),
      )
      .orderBy(desc(schema.knowledgeGraphConnectorsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByKnowledgeGraph(
    knowledgeGraphId: string,
  ): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeGraphConnectorsTable)
      .where(
        eq(
          schema.knowledgeGraphConnectorsTable.knowledgeGraphId,
          knowledgeGraphId,
        ),
      );

    return result?.count ?? 0;
  }

  static async findById(id: string): Promise<KnowledgeGraphConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeGraphConnectorsTable)
      .where(eq(schema.knowledgeGraphConnectorsTable.id, id));

    return result ?? null;
  }

  static async create(
    data: InsertKnowledgeGraphConnector,
  ): Promise<KnowledgeGraphConnector> {
    const [result] = await db
      .insert(schema.knowledgeGraphConnectorsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeGraphConnector>,
  ): Promise<KnowledgeGraphConnector | null> {
    const [result] = await db
      .update(schema.knowledgeGraphConnectorsTable)
      .set(data)
      .where(eq(schema.knowledgeGraphConnectorsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async findAllEnabled(): Promise<KnowledgeGraphConnector[]> {
    return await db
      .select()
      .from(schema.knowledgeGraphConnectorsTable)
      .where(eq(schema.knowledgeGraphConnectorsTable.enabled, true));
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.knowledgeGraphConnectorsTable)
      .where(eq(schema.knowledgeGraphConnectorsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default KnowledgeGraphConnectorModel;
