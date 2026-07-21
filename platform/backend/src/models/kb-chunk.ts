import { getEmbeddingColumnName } from "@archestra/shared";
import { count, eq, sql } from "drizzle-orm";
import db, { schema } from "@/database";
import type { AclEntry, InsertKbChunk, KbChunk } from "@/types";

export interface VectorSearchResult {
  id: string;
  content: string;
  chunkIndex: number;
  documentId: string;
  sourceId?: string | null;
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

  /**
   * Bulk-apply a connector-level ACL to every chunk (org-wide / team-scoped
   * connectors, via `refreshConnectorDocumentAccessControlLists`). Epoch-fenced
   * like the document-level variant: a stale-epoch write (concurrent visibility
   * change) no-ops. Rows already at the target ACL are skipped.
   */
  static async updateAclByConnector(params: {
    connectorId: string;
    acl: AclEntry[];
    aclConfigEpoch: number;
  }): Promise<number> {
    const aclJson = JSON.stringify(params.acl);
    const result = await db.execute(sql`
      WITH updated AS (
        UPDATE ${schema.kbChunksTable} AS chunk
        SET acl = ${aclJson}::jsonb
        FROM ${schema.kbDocumentsTable} AS document
        JOIN ${schema.knowledgeBaseConnectorsTable} AS connector
          ON connector.id = document.connector_id
        WHERE chunk.document_id = document.id
          AND document.connector_id = ${params.connectorId}
          AND connector.acl_config_epoch = ${params.aclConfigEpoch}
          AND chunk.acl IS DISTINCT FROM ${aclJson}::jsonb
        RETURNING 1
      )
      SELECT COUNT(*)::int AS count FROM updated
    `);

    const count = result.rows[0]?.count;
    return typeof count === "number" ? count : Number(count ?? 0);
  }

  // The permission pass's per-document chunk rewrite lives in
  // `KbDocumentModel.applyContainerAssignment` — it has to share one statement
  // (and so one epoch-fence evaluation) with the document-row write.

  static async vectorSearch(params: {
    connectorIds: string[];
    queryEmbedding: number[];
    dimensions: number;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    /** Defense-in-depth env isolation: require the connector to be in this env. */
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const {
      connectorIds,
      queryEmbedding,
      dimensions,
      userAcl,
      bypassAcl = false,
      environmentId,
      limit = 10,
    } = params;
    if (connectorIds.length === 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const aclEntries = bypassAcl
      ? null
      : sql.join(
          userAcl.map((entry) => sql`${entry}`),
          sql`, `,
        );

    const envFilter =
      environmentId !== undefined
        ? sql`AND kbc.environment_id IS NOT DISTINCT FROM ${environmentId}`
        : sql``;

    const col = sql.raw(getEmbeddingColumnName(dimensions));
    const vectorCast = sql.raw(`::vector(${dimensions})`);
    const rows = await db.execute(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        1 - (c.${col} <=> ${embeddingStr}${vectorCast}) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        AND c.${col} IS NOT NULL
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
      ORDER BY c.${col} <=> ${embeddingStr}${vectorCast}
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }

  /**
   * Return the set of embedding dimensions that actually have stored vectors for
   * the given connectors (one entry per non-empty per-dimension column). Used to
   * diagnose a dimension mismatch when a search returns nothing: if documents
   * were ingested at a dimension other than the one now configured, the search
   * targets an empty column and silently finds nothing.
   */
  static async getPopulatedEmbeddingDimensions(
    connectorIds: string[],
  ): Promise<Set<number>> {
    if (connectorIds.length === 0) return new Set();
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await db.execute(sql`
      SELECT
        bool_or(c.embedding IS NOT NULL) AS "d1536",
        bool_or(c.embedding_1024 IS NOT NULL) AS "d1024",
        bool_or(c.embedding_768 IS NOT NULL) AS "d768",
        bool_or(c.embedding_384 IS NOT NULL) AS "d384",
        bool_or(c.embedding_3072 IS NOT NULL) AS "d3072"
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      WHERE d.connector_id IN (${ids})
    `);
    const row = result.rows[0] as Record<string, boolean | null> | undefined;
    const dimensions = new Set<number>();
    if (row) {
      if (row.d1536) dimensions.add(1536);
      if (row.d1024) dimensions.add(1024);
      if (row.d768) dimensions.add(768);
      if (row.d384) dimensions.add(384);
      if (row.d3072) dimensions.add(3072);
    }
    return dimensions;
  }

  static async fullTextSearch(params: {
    connectorIds: string[];
    queryText: string;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    /** Defense-in-depth env isolation: require the connector to be in this env. */
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const {
      connectorIds,
      queryText,
      userAcl,
      bypassAcl = false,
      environmentId,
      limit = 10,
    } = params;
    if (connectorIds.length === 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const aclEntries = bypassAcl
      ? null
      : sql.join(
          userAcl.map((entry) => sql`${entry}`),
          sql`, `,
        );

    const envFilter =
      environmentId !== undefined
        ? sql`AND kbc.environment_id IS NOT DISTINCT FROM ${environmentId}`
        : sql``;

    const orQuery = queryText.split(/\s+/).filter(Boolean).join(" OR ");

    const rows = await db.execute(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        ts_rank(c.search_vector, websearch_to_tsquery('english', ${orQuery})) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        AND c.search_vector @@ websearch_to_tsquery('english', ${orQuery})
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
      ORDER BY score DESC
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }

  static async updateEmbeddings(
    updates: Array<{ chunkId: string; embedding: number[] }>,
    dimensions: number,
  ): Promise<void> {
    if (updates.length === 0) return;

    const col = getEmbeddingColumnName(dimensions);
    const values = updates
      .map(
        (u) =>
          `('${u.chunkId}'::uuid, '[${u.embedding.join(",")}]'::vector(${dimensions}))`,
      )
      .join(", ");

    await db.execute(
      sql.raw(`
        UPDATE kb_chunks AS c
        SET ${col} = v.embedding
        FROM (VALUES ${values}) AS v(id, embedding)
        WHERE c.id = v.id
      `),
    );
  }
}

export default KbChunkModel;
