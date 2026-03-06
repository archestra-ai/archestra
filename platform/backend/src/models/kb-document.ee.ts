import { and, count, desc, eq } from "drizzle-orm";
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

  static async findByKnowledgeBase(params: {
    knowledgeBaseId: string;
    limit?: number;
    offset?: number;
  }): Promise<KbDocument[]> {
    let query = db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        eq(schema.kbDocumentsTable.knowledgeBaseId, params.knowledgeBaseId),
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

  static async findByContentHash(params: {
    knowledgeBaseId: string;
    contentHash: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.knowledgeBaseId, params.knowledgeBaseId),
          eq(schema.kbDocumentsTable.contentHash, params.contentHash),
        ),
      );

    return result ?? null;
  }

  static async findBySourceId(params: {
    knowledgeBaseId: string;
    sourceType: "connector" | "api";
    sourceId: string;
  }): Promise<KbDocument | null> {
    const [result] = await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.knowledgeBaseId, params.knowledgeBaseId),
          eq(schema.kbDocumentsTable.sourceType, params.sourceType),
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
      .where(eq(schema.kbDocumentsTable.knowledgeBaseId, knowledgeBaseId));

    return result?.count ?? 0;
  }

  static async findPending(params: { limit?: number }): Promise<KbDocument[]> {
    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.embeddingStatus, "pending"))
      .orderBy(schema.kbDocumentsTable.createdAt)
      .limit(params.limit ?? 10);
  }
}

export default KbDocumentModel;
