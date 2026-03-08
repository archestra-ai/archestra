import { and, eq, sql } from "drizzle-orm";
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
    const rows = await db.execute(sql`
      SELECT d.*
      FROM kb_documents d
      JOIN knowledge_base_connector_assignment kbca ON kbca.connector_id = d.connector_id
      WHERE kbca.knowledge_base_id = ${params.knowledgeBaseId}
      ORDER BY d.created_at DESC
      ${params.limit !== undefined ? sql`LIMIT ${params.limit}` : sql``}
      ${params.offset !== undefined ? sql`OFFSET ${params.offset}` : sql``}
    `);

    return rows.rows as unknown as KbDocument[];
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
    const rows = await db.execute(sql`
      SELECT COUNT(*)::int AS count
      FROM kb_documents d
      JOIN knowledge_base_connector_assignment kbca ON kbca.connector_id = d.connector_id
      WHERE kbca.knowledge_base_id = ${knowledgeBaseId}
    `);

    return (rows.rows[0] as { count: number })?.count ?? 0;
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
