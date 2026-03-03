import { count, desc, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  InsertKnowledgeBaseConnector,
  KnowledgeBaseConnector,
  UpdateKnowledgeBaseConnector,
} from "@/types";

class KnowledgeBaseConnectorModel {
  static async findByKnowledgeBase(params: {
    knowledgeBaseId: string;
    limit?: number;
    offset?: number;
  }): Promise<KnowledgeBaseConnector[]> {
    let query = db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        eq(
          schema.knowledgeBaseConnectorsTable.knowledgeBaseId,
          params.knowledgeBaseId,
        ),
      )
      .orderBy(desc(schema.knowledgeBaseConnectorsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async countByKnowledgeBase(knowledgeBaseId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.knowledgeBaseConnectorsTable)
      .where(
        eq(
          schema.knowledgeBaseConnectorsTable.knowledgeBaseId,
          knowledgeBaseId,
        ),
      );

    return result?.count ?? 0;
  }

  static async findById(id: string): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id));

    return result ?? null;
  }

  static async create(
    data: InsertKnowledgeBaseConnector,
  ): Promise<KnowledgeBaseConnector> {
    const [result] = await db
      .insert(schema.knowledgeBaseConnectorsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKnowledgeBaseConnector>,
  ): Promise<KnowledgeBaseConnector | null> {
    const [result] = await db
      .update(schema.knowledgeBaseConnectorsTable)
      .set(data)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async findAllEnabled(): Promise<KnowledgeBaseConnector[]> {
    return await db
      .select()
      .from(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.enabled, true));
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.knowledgeBaseConnectorsTable)
      .where(eq(schema.knowledgeBaseConnectorsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }
}

export default KnowledgeBaseConnectorModel;
