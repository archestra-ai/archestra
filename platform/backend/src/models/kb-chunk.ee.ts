import { and, count, eq } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertKbChunk, KbChunk } from "@/types";

class KbChunkModel {
  static async findByDocument(documentId: string): Promise<KbChunk[]> {
    return await db
      .select()
      .from(schema.kbChunksTable)
      .where(eq(schema.kbChunksTable.documentId, documentId))
      .orderBy(schema.kbChunksTable.chunkIndex);
  }

  static async insertMany(chunks: InsertKbChunk[]): Promise<KbChunk[]> {
    if (chunks.length === 0) return [];

    return await db.insert(schema.kbChunksTable).values(chunks).returning();
  }

  static async deleteByDocument(documentId: string): Promise<number> {
    const result = await db
      .delete(schema.kbChunksTable)
      .where(eq(schema.kbChunksTable.documentId, documentId));

    return result.rowCount ?? 0;
  }

  static async countByKnowledgeBase(knowledgeBaseId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbChunksTable)
      .where(eq(schema.kbChunksTable.knowledgeBaseId, knowledgeBaseId));

    return result?.count ?? 0;
  }

  static async countByDocument(documentId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbChunksTable)
      .where(eq(schema.kbChunksTable.documentId, documentId));

    return result?.count ?? 0;
  }
}

export default KbChunkModel;
