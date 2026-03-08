import { and, count, desc, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertKbDocument, KbDocument, UpdateKbDocument } from "@/types";

class KbDocumentModel {
  static async findById(id: string): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result ?? null;
  }

  static async findByIds(ids: string[]): Promise<KbDocument[]> {
    if (ids.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(inArray(schema.kbDocumentsTable.id, ids));
  }

  static async findByKnowledgeBase(params: {
    knowledgeBaseId: string;
    limit?: number;
    offset?: number;
  }): Promise<KbDocument[]> {
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        title: schema.kbDocumentsTable.title,
        content: schema.kbDocumentsTable.content,
        contentHash: schema.kbDocumentsTable.contentHash,
        sourceUrl: schema.kbDocumentsTable.sourceUrl,
        acl: schema.kbDocumentsTable.acl,
        metadata: schema.kbDocumentsTable.metadata,
        embeddingStatus: schema.kbDocumentsTable.embeddingStatus,
        chunkCount: schema.kbDocumentsTable.chunkCount,
        createdAt: schema.kbDocumentsTable.createdAt,
        updatedAt: schema.kbDocumentsTable.updatedAt,
      })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          params.knowledgeBaseId,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.createdAt))
      .$dynamic();

    if (params.limit !== undefined) {
      query = query.limit(params.limit);
    }
    if (params.offset !== undefined) {
      query = query.offset(params.offset);
    }

    return await query;
  }

  static async findBySourceId(params: {
    connectorId: string;
    sourceId: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.sourceId, params.sourceId),
        ),
      );

    return result ?? null;
  }

  static async create(data: InsertKbDocument): Promise<KbDocument> {
    const [result] = await db
      .insert(schema.kbDocumentsTable)
      .values(data)
      .returning();

    return result;
  }

  static async update(
    id: string,
    data: Partial<UpdateKbDocument>,
  ): Promise<KbDocument | null> {
    const [result] = await db
      .update(schema.kbDocumentsTable)
      .set(data)
      .where(eq(schema.kbDocumentsTable.id, id))
      .returning();

    return result ?? null;
  }

  static async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.id, id));

    return result.rowCount !== null && result.rowCount > 0;
  }

  static async countByKnowledgeBase(knowledgeBaseId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorAssignmentsTable,
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.connectorId,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        eq(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseId,
        ),
      );

    return result?.count ?? 0;
  }
}

export default KbDocumentModel;
