import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  AclEntry,
  ConnectorType,
  InsertKbDocument,
  KbDocument,
  UpdateKbDocument,
} from "@/types";

type KbDocumentListItem = KbDocument & {
  connectorType: ConnectorType;
};

type KbDocumentListItemWithoutContent = Omit<KbDocumentListItem, "content">;

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
    search?: string;
  }): Promise<KbDocument[]> {
    const normalizedSearch = params.search?.trim();
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
        and(
          eq(
            schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
            params.knowledgeBaseId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
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

  static async findListItemsByConnector(params: {
    connectorId: string;
    organizationId: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): Promise<KbDocumentListItemWithoutContent[]> {
    const normalizedSearch = params.search?.trim();
    let query = db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
        title: schema.kbDocumentsTable.title,
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
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      )
      .orderBy(desc(schema.kbDocumentsTable.updatedAt))
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

  static async findBySourceIds(params: {
    connectorId: string;
    sourceIds: string[];
  }): Promise<KbDocument[]> {
    if (params.sourceIds.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          inArray(schema.kbDocumentsTable.sourceId, params.sourceIds),
        ),
      );
  }

  static async findByConnectorSourcePairs(
    pairs: { connectorId: string; sourceId: string }[],
  ): Promise<KbDocument[]> {
    if (pairs.length === 0) return [];

    return await db
      .select()
      .from(schema.kbDocumentsTable)
      .where(
        or(
          ...pairs.map((pair) =>
            and(
              eq(schema.kbDocumentsTable.connectorId, pair.connectorId),
              eq(schema.kbDocumentsTable.sourceId, pair.sourceId),
            ),
          ),
        ),
      );
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

  /**
   * Recover documents whose embedding stalled. A `batch_embedding` task that
   * exhausts its retries (or a worker that dies mid-embed) leaves a document at
   * `pending`/`processing` with nothing queued to finish it — and the sync
   * checkpoint has already advanced past it, so a resume won't re-ingest it.
   * Reset any such document not touched for `olderThanSeconds` back to `pending`
   * (bumping `updated_at` so the next sweep won't re-grab it) and return their
   * ids, capped at `limit`, for the caller to re-enqueue embedding.
   *
   * Age-gated well beyond the batch task's total retry window so a batch still
   * legitimately in flight is never disturbed; re-embedding is idempotent anyway
   * (the embedder skips any document that is no longer `pending`).
   */
  static async recoverStalledEmbeddings(params: {
    olderThanSeconds: number;
    limit: number;
  }): Promise<string[]> {
    const { rows } = await db.execute<{ id: string }>(sql`
      UPDATE kb_documents
      SET embedding_status = 'pending', updated_at = now()
      WHERE id IN (
        SELECT id FROM kb_documents
        WHERE embedding_status IN ('pending', 'processing')
          AND updated_at < now() - make_interval(secs => ${params.olderThanSeconds})
        ORDER BY updated_at ASC
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id
    `);
    return rows.map((r) => r.id);
  }

  static async countByConnector(connectorId: string): Promise<number> {
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result?.count ?? 0;
  }

  static async countByConnectorWithSearch(params: {
    connectorId: string;
    organizationId: string;
    search?: string;
  }): Promise<number> {
    const normalizedSearch = params.search?.trim();
    const [result] = await db
      .select({ count: count() })
      .from(schema.kbDocumentsTable)
      .innerJoin(
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
          normalizedSearch
            ? ilike(schema.kbDocumentsTable.title, `%${normalizedSearch}%`)
            : undefined,
        ),
      );

    return result?.count ?? 0;
  }

  static async findListItemByIdAndConnector(params: {
    documentId: string;
    connectorId: string;
    organizationId: string;
  }): Promise<KbDocumentListItem | null> {
    const [result] = await db
      .select({
        id: schema.kbDocumentsTable.id,
        organizationId: schema.kbDocumentsTable.organizationId,
        sourceId: schema.kbDocumentsTable.sourceId,
        connectorId: schema.kbDocumentsTable.connectorId,
        connectorType: schema.knowledgeBaseConnectorsTable.connectorType,
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
        schema.knowledgeBaseConnectorsTable,
        eq(
          schema.knowledgeBaseConnectorsTable.id,
          schema.kbDocumentsTable.connectorId,
        ),
      )
      .where(
        and(
          eq(schema.kbDocumentsTable.id, params.documentId),
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.organizationId, params.organizationId),
          eq(
            schema.knowledgeBaseConnectorsTable.organizationId,
            params.organizationId,
          ),
        ),
      )
      .limit(1);

    return result ?? null;
  }

  static async deleteByConnector(connectorId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.connectorId, connectorId));

    return result.rowCount ?? 0;
  }

  static async deleteByConnectorAndSourceId(params: {
    connectorId: string;
    sourceId: string;
  }): Promise<boolean> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          eq(schema.kbDocumentsTable.sourceId, params.sourceId),
        ),
      )
      .returning({ id: schema.kbDocumentsTable.id });
    return result.length > 0;
  }

  static async deleteByOrganization(organizationId: string): Promise<number> {
    const result = await db
      .delete(schema.kbDocumentsTable)
      .where(eq(schema.kbDocumentsTable.organizationId, organizationId));

    return result.rowCount ?? 0;
  }

  static async updateAclByConnector(
    connectorId: string,
    acl: AclEntry[],
  ): Promise<number> {
    // Skip rows that already have the target ACL to avoid unnecessary rewrites,
    // WAL churn, and vacuum work when connector visibility is re-applied.
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbDocumentsTable}
        SET acl = ${JSON.stringify(acl)}::jsonb
        WHERE ${schema.kbDocumentsTable.connectorId} = ${connectorId}
          AND ${schema.kbDocumentsTable.acl} IS DISTINCT FROM ${JSON.stringify(acl)}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  static async countByKnowledgeBaseIds(
    knowledgeBaseIds: string[],
  ): Promise<Map<string, number>> {
    if (knowledgeBaseIds.length === 0) return new Map();

    const results = await db
      .select({
        knowledgeBaseId:
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
        count: count(),
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
        inArray(
          schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId,
          knowledgeBaseIds,
        ),
      )
      .groupBy(schema.knowledgeBaseConnectorAssignmentsTable.knowledgeBaseId);

    return new Map(results.map((r) => [r.knowledgeBaseId, r.count]));
  }
}

export default KbDocumentModel;
