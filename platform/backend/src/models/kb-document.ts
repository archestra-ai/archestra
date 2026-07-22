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
        containerKey: schema.kbDocumentsTable.containerKey,
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
    /** Restrict to documents whose effective audience holds this group token. */
    groupToken?: string;
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
        containerKey: schema.kbDocumentsTable.containerKey,
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
          groupTokenFilter(params.groupToken),
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
    /** Restrict to documents whose effective audience holds this group token. */
    groupToken?: string;
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
          groupTokenFilter(params.groupToken),
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
        containerKey: schema.kbDocumentsTable.containerKey,
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

  /**
   * Bulk-apply a connector-level ACL to every document (org-wide / team-scoped
   * connectors, via `refreshConnectorDocumentAccessControlLists`). Epoch-fenced:
   * if the connector's `acl_config_epoch` changed since the caller read it (a
   * concurrent visibility/teamIds change), the whole write no-ops so the newest
   * config change wins regardless of ordering. Rows already at the target ACL
   * are skipped to avoid needless GIN churn.
   */
  static async updateAclByConnector(params: {
    connectorId: string;
    acl: AclEntry[];
    aclConfigEpoch: number;
  }): Promise<number> {
    const aclJson = JSON.stringify(params.acl);
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl = ${aclJson}::jsonb
        FROM ${schema.knowledgeBaseConnectorsTable} AS c
        WHERE d.connector_id = c.id
          AND d.connector_id = ${params.connectorId}
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
          AND d.acl IS DISTINCT FROM ${aclJson}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  // ===== Permission-sync pass (auto-sync-permissions connectors) =====

  /**
   * Live ACL coverage for a connector: how many documents exist and how many
   * are still fail-closed (`acl = []` — awaiting a permission-sync pass, or
   * swept because they are no longer visible upstream). This is the number an
   * admin reads to know whether "everything ingested is reconciled right now",
   * instead of inferring it from run history.
   */
  static async getAclCoverageByConnector(connectorId: string): Promise<{
    totalDocuments: number;
    failClosedDocuments: number;
  }> {
    const { rows } = await db.execute<{
      total: number;
      fail_closed: number;
    }>(sql`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE acl = '[]'::jsonb)::int AS fail_closed
      FROM ${schema.kbDocumentsTable}
      WHERE connector_id = ${connectorId}
    `);
    return {
      totalDocuments: Number(rows[0]?.total ?? 0),
      failClosedDocuments: Number(rows[0]?.fail_closed ?? 0),
    };
  }

  /**
   * Distinct `group:` ACL tokens granting access across a connector's
   * documents, with how many documents each grants. Group grants live on the
   * container-audience rows (a document counts for every group in its
   * container's audience); documents still carrying legacy materialized
   * doc-level group tokens (pre-container passes) are counted too. Includes
   * groups the membership snapshot has no rows for, which is how an admin
   * spots a grant that currently resolves to nobody.
   */
  static async getGroupTokenDocumentCounts(
    connectorId: string,
  ): Promise<Map<string, number>> {
    const { rows } = await db.execute<{ token: string; count: number }>(sql`
      SELECT token, SUM(count)::int AS count FROM (
        SELECT token, count(*)::int AS count
        FROM ${schema.kbDocumentsTable} d
        JOIN ${schema.kbContainerAclsTable} c
          ON c.connector_id = d.connector_id
         AND c.container_key = d.container_key,
             LATERAL jsonb_array_elements_text(c.acl) AS token
        WHERE d.connector_id = ${connectorId} AND token LIKE 'group:%'
        GROUP BY token
        UNION ALL
        SELECT token, count(*)::int AS count
        FROM ${schema.kbDocumentsTable} d,
             LATERAL jsonb_array_elements_text(d.acl) AS token
        WHERE d.connector_id = ${connectorId} AND token LIKE 'group:%'
        GROUP BY token
      ) AS combined
      GROUP BY token
    `);
    return new Map(rows.map((row) => [row.token, Number(row.count)]));
  }

  /**
   * Lean projection of the current per-document assignment state for a batch
   * of source ids, used by the permission-sync pass to diff (adopt / reassign
   * / exception changes) without loading document content. O(batch) memory.
   */
  static async findAclStateBySourceIds(params: {
    connectorId: string;
    sourceIds: string[];
  }): Promise<
    {
      id: string;
      sourceId: string | null;
      acl: string[];
      containerKey: string | null;
    }[]
  > {
    if (params.sourceIds.length === 0) return [];

    return await db
      .select({
        id: schema.kbDocumentsTable.id,
        sourceId: schema.kbDocumentsTable.sourceId,
        acl: schema.kbDocumentsTable.acl,
        containerKey: schema.kbDocumentsTable.containerKey,
      })
      .from(schema.kbDocumentsTable)
      .where(
        and(
          eq(schema.kbDocumentsTable.connectorId, params.connectorId),
          inArray(schema.kbDocumentsTable.sourceId, params.sourceIds),
        ),
      );
  }

  /**
   * Write a document's container assignment — its ACL (the `container:` token
   * plus any per-document exception tokens) and the bookkeeping `container_key`
   * column — together with its chunks' ACLs, in ONE statement.
   *
   * One statement, not two writes in a transaction, because the epoch fence has
   * to be evaluated ONCE. Postgres runs every branch of a data-modifying CTE
   * against the same snapshot and commits them together, so the document row
   * and its chunks either both move to the new ACL or neither does. Two
   * separately-fenced statements could not promise that even inside a
   * transaction: at READ COMMITTED the second one re-reads `acl_config_epoch`,
   * so a visibility switch landing between them fences out the document write
   * while the chunk write has already committed — leaving the chunks (which the
   * search filter actually reads) carrying a container token the document row
   * knows nothing about.
   *
   * Chunk rows already at the target ACL are skipped to avoid needless GIN
   * churn. Returns whether the document row moved, and how many chunks were
   * rewritten (the wide write — only paid for documents that actually changed).
   */
  static async applyContainerAssignment(params: {
    documentId: string;
    connectorId: string;
    acl: AclEntry[];
    containerKey: string;
    aclConfigEpoch: number;
  }): Promise<{ documentUpdated: boolean; chunksRewritten: number }> {
    const aclJson = JSON.stringify(params.acl);
    const result = await db.execute<{
      documents_updated: number;
      chunks_rewritten: number;
    }>(sql`
      WITH fence AS (
        SELECT d.id
        FROM ${schema.kbDocumentsTable} AS d
        JOIN ${schema.knowledgeBaseConnectorsTable} AS c ON c.id = d.connector_id
        WHERE d.id = ${params.documentId}
          AND d.connector_id = ${params.connectorId}
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
      ),
      chunks AS (
        UPDATE ${schema.kbChunksTable} AS chunk
        SET acl = ${aclJson}::jsonb
        WHERE chunk.document_id IN (SELECT id FROM fence)
          AND chunk.acl IS DISTINCT FROM ${aclJson}::jsonb
        RETURNING 1
      ),
      document AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl = ${aclJson}::jsonb,
            container_key = ${params.containerKey}
        WHERE d.id IN (SELECT id FROM fence)
        RETURNING 1
      )
      SELECT (SELECT COUNT(*)::int FROM document) AS documents_updated,
             (SELECT COUNT(*)::int FROM chunks) AS chunks_rewritten
    `);
    const row = result.rows[0];
    return {
      documentUpdated: Number(row?.documents_updated ?? 0) > 0,
      chunksRewritten: Number(row?.chunks_rewritten ?? 0),
    };
  }

  /**
   * Keyset-paginated `{ id, sourceId }` scan of the documents assigned to a
   * top-level container (the container itself plus its `<container>/<child>`
   * nested exceptions), used by the pass's per-container fail-close set-diff.
   * O(limit) memory; served by the (connector_id, container_key) index.
   */
  static async findDocRefsByContainerScope(params: {
    connectorId: string;
    /** Null scope = documents not assigned to ANY container yet. */
    topLevelContainerKey: string | null;
    afterId?: string | null;
    limit: number;
  }): Promise<{ id: string; sourceId: string | null }[]> {
    const t = schema.kbDocumentsTable;
    const scope =
      params.topLevelContainerKey === null
        ? sql`${t.containerKey} IS NULL`
        : sql`(${t.containerKey} = ${params.topLevelContainerKey}
               OR starts_with(${t.containerKey}, ${`${params.topLevelContainerKey}/`}))`;
    return await db
      .select({ id: t.id, sourceId: t.sourceId })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          scope,
          params.afterId ? sql`${t.id} > ${params.afterId}::uuid` : undefined,
        ),
      )
      .orderBy(t.id)
      .limit(params.limit);
  }

  /**
   * Keyset-paginated `{ id, metadata }` scan of documents not assigned to any
   * container yet (`container_key IS NULL`) — the delta pass maps their
   * metadata to top-level scope keys so freshly-ingested documents are adopted
   * without waiting for the periodic full reconcile. Served by the
   * (connector_id, container_key) index; empty in steady state.
   */
  static async findUnassignedDocMetadata(params: {
    connectorId: string;
    afterId?: string | null;
    limit: number;
  }): Promise<{ id: string; metadata: Record<string, unknown> | null }[]> {
    const t = schema.kbDocumentsTable;
    return await db
      .select({ id: t.id, metadata: t.metadata })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          sql`${t.containerKey} IS NULL`,
          params.afterId ? sql`${t.id} > ${params.afterId}::uuid` : undefined,
        ),
      )
      .orderBy(t.id)
      .limit(params.limit);
  }

  /**
   * Fail-close (acl=[]) an explicit batch of documents the pass proved are no
   * longer visible upstream (present in our DB, absent from the completed
   * container enumeration). Clears both the document and its chunk ACLs;
   * `container_key` is kept as bookkeeping of the last known container.
   * Epoch-fenced. Returns the number of documents fail-closed.
   */
  static async failCloseDocuments(params: {
    documentIds: string[];
    connectorId: string;
    aclConfigEpoch: number;
  }): Promise<number> {
    if (params.documentIds.length === 0) return 0;

    const ids = sql.join(
      params.documentIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const result = await db.execute<{ id: string }>(sql`
      WITH gone AS (
        SELECT d.id
        FROM ${schema.kbDocumentsTable} AS d
        JOIN ${schema.knowledgeBaseConnectorsTable} AS c
          ON c.id = d.connector_id
        WHERE d.connector_id = ${params.connectorId}
          AND c.acl_config_epoch = ${params.aclConfigEpoch}
          AND d.id IN (${ids})
          AND d.acl IS DISTINCT FROM '[]'::jsonb
      ),
      cleared_chunks AS (
        UPDATE ${schema.kbChunksTable} AS chunk
        SET acl = '[]'::jsonb
        FROM gone
        WHERE chunk.document_id = gone.id
          AND chunk.acl IS DISTINCT FROM '[]'::jsonb
        RETURNING 1
      ),
      cleared_docs AS (
        UPDATE ${schema.kbDocumentsTable} AS d
        SET acl = '[]'::jsonb
        FROM gone
        WHERE d.id = gone.id
        RETURNING d.id
      )
      SELECT id FROM cleared_docs
    `);
    return result.rows.length;
  }

  /**
   * Keyset-paginated read-back of a connector's ingested documents for
   * container-scoped permission tagging (GitHub: repo → its docs). Filters by an
   * optional `metadata` JSONB equality map, orders by id ascending, and returns
   * a lean `{ id, sourceId, metadata }` projection. O(limit) memory.
   */
  static async findIngestedForReadback(params: {
    connectorId: string;
    metadataFilter?: Record<string, string>;
    afterId?: string | null;
    limit: number;
  }): Promise<
    {
      id: string;
      sourceId: string | null;
      metadata: Record<string, unknown> | null;
    }[]
  > {
    const t = schema.kbDocumentsTable;
    const metadataConditions = Object.entries(params.metadataFilter ?? {}).map(
      ([key, value]) => sql`${t.metadata}->>${key} = ${value}`,
    );
    return await db
      .select({
        id: t.id,
        sourceId: t.sourceId,
        metadata: t.metadata,
      })
      .from(t)
      .where(
        and(
          eq(t.connectorId, params.connectorId),
          params.afterId ? sql`${t.id} > ${params.afterId}::uuid` : undefined,
          ...metadataConditions,
        ),
      )
      .orderBy(t.id)
      .limit(params.limit);
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

/**
 * A document is "granted to a group" when its EFFECTIVE audience holds the
 * group token: directly on the document ACL (legacy materialized form), or
 * on the container-ACL row its `container_key` references (the auto-sync
 * indirection the UI expands the same way).
 */
function groupTokenFilter(groupToken: string | undefined) {
  if (!groupToken) return undefined;
  const tokenJson = JSON.stringify([groupToken]);
  const d = schema.kbDocumentsTable;
  const c = schema.kbContainerAclsTable;
  return sql`(${d.acl} @> ${tokenJson}::jsonb OR EXISTS (
    SELECT 1 FROM ${c}
    WHERE ${c.connectorId} = ${d.connectorId}
      AND ${c.containerKey} = ${d.containerKey}
      AND ${c.acl} @> ${tokenJson}::jsonb
  ))`;
}

export default KbDocumentModel;
