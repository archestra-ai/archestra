import { count, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { InsertKbChunk, KbChunk } from "@/types";

export interface VectorSearchResult {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  title: string;
  sourceUrl: string | null;
  metadata: Record<string, unknown> | null;
  connectorType: string | null;
  score: number;
}

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

  static async countByDocument(documentId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbChunksTable)
      .where(eq(schema.kbChunksTable.documentId, documentId));

    return result?.count ?? 0;
  }

  static async vectorSearch(params: {
    connectorIds: string[];
    queryEmbedding: number[];
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const { connectorIds, queryEmbedding, limit = 10 } = params;
    if (connectorIds.length === 0) return [];
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );

    const rows = await db.execute(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        1 - (c.embedding <=> ${embeddingStr}::vector(1536)) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        AND c.embedding IS NOT NULL
      ORDER BY c.embedding <=> ${embeddingStr}::vector(1536)
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }

  static async fullTextSearch(params: {
    connectorIds: string[];
    queryText: string;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const { connectorIds, queryText, limit = 10 } = params;
    if (connectorIds.length === 0) return [];
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );

    const rows = await db.execute(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        ts_rank(c.search_vector, plainto_tsquery('english', ${queryText})) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        AND c.search_vector @@ plainto_tsquery('english', ${queryText})
      ORDER BY score DESC
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }

  static async updateEmbeddings(
    updates: Array<{ chunkId: string; embedding: number[] }>,
  ): Promise<void> {
    if (updates.length === 0) return;

    const values = updates
      .map(
        (u) =>
          `('${u.chunkId}'::uuid, '[${u.embedding.join(",")}]'::vector(1536))`,
      )
      .join(", ");

    await db.execute(
      sql.raw(`
        UPDATE kb_chunks AS c
        SET embedding = v.embedding
        FROM (VALUES ${values}) AS v(id, embedding)
        WHERE c.id = v.id
      `),
    );
  }
}

export default KbChunkModel;
