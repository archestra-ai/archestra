import {
  DEFAULT_TEXT_SEARCH_LANGUAGE,
  getEmbeddingColumnName,
  type TextSearchLanguage,
} from "@archestra/shared";
import { count, eq, type SQL, sql } from "drizzle-orm";
import config from "@/config";
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

/**
 * Name of the ParadeDB BM25 index on kb_chunks. Created (conditionally) by
 * migration SQL, probed at runtime by `probeBm25Support` — the literal in the
 * migration must match this constant.
 */
export const KB_CHUNKS_BM25_INDEX = "kb_chunks_bm25_idx";

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
    const rows = await executeWithSearchTimeout(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        1 - (c.${col} <=> ${embeddingStr}${vectorCast}) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        -- Defense-in-depth: never serve chunks from a soft-deleted connector.
        -- The connectorIds are resolved through notDeleted()-filtered resolvers
        -- upstream, but retrieval is a security surface so we re-check here.
        -- (kbc is a LEFT JOIN, so a genuinely-unmatched row keeps deleted_at
        -- NULL and still passes — this only drops soft-deleted connectors.)
        AND kbc.deleted_at IS NULL
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

  /**
   * Distinct text-search configurations in use across a set of connectors.
   *
   * Read from the connector rows rather than from `kb_chunks`, because the
   * connector table is small and indexed while the chunk table is the largest
   * in the corpus. Callers pass the result to `fullTextSearch`, which needs the
   * languages as literals to keep its tsquery constant-folded (see there).
   */
  static async getTextSearchLanguages(
    connectorIds: string[],
  ): Promise<TextSearchLanguage[]> {
    if (connectorIds.length === 0) return [];
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const result = await db.execute(sql`
      SELECT DISTINCT fts_language AS "ftsLanguage"
      FROM knowledge_base_connectors
      WHERE id IN (${ids}) AND deleted_at IS NULL
    `);
    return (result.rows as Array<{ ftsLanguage: TextSearchLanguage }>).map(
      (row) => row.ftsLanguage,
    );
  }

  /**
   * Whether this database can serve BM25 keyword ranking: the pg_search
   * extension is installed AND a ready, valid ParadeDB index belongs to
   * kb_chunks. Plain catalog reads, so it answers (negatively) on any
   * PostgreSQL, including PGlite.
   */
  static async probeBm25Support(): Promise<{
    extensionInstalled: boolean;
    indexPresent: boolean;
  }> {
    const result = await db.execute(sql`
      SELECT
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_search')
          AS "extensionInstalled",
        EXISTS (
          SELECT 1
          FROM pg_index index_state
          JOIN pg_class idx ON idx.oid = index_state.indexrelid
          JOIN pg_am access_method ON access_method.oid = idx.relam
          JOIN pg_class indexed_table ON indexed_table.oid = index_state.indrelid
          JOIN pg_namespace indexed_schema
            ON indexed_schema.oid = indexed_table.relnamespace
          WHERE idx.relname = ${KB_CHUNKS_BM25_INDEX}
            AND idx.relkind = 'i'
            AND indexed_table.relname = 'kb_chunks'
            AND indexed_schema.nspname = current_schema()
            AND access_method.amname IN ('bm25', 'paradedb')
            AND index_state.indisvalid
            AND index_state.indisready
        ) AS "indexPresent"
    `);
    const row = result.rows[0] as
      | { extensionInstalled: boolean; indexPresent: boolean }
      | undefined;
    return {
      extensionInstalled: row?.extensionInstalled === true,
      indexPresent: row?.indexPresent === true,
    };
  }

  static async fullTextSearch(params: {
    connectorIds: string[];
    queryText: string;
    /**
     * Text-search configurations to parse the query under, from
     * {@link getTextSearchLanguages}. Empty falls back to the column default.
     * Only the ts_rank path uses these; the BM25 index has one fixed
     * (English) tokenizer and the caller routes non-English corpora away.
     */
    languages?: TextSearchLanguage[];
    /**
     * Which engine ranks the keyword lane. "bm25" requires the pg_search
     * extension and its kb_chunks index — callers gate on
     * `bm25Capability.isReady()`; "ts_rank" (default) is plain PostgreSQL.
     */
    ranking?: "ts_rank" | "bm25";
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    /** Defense-in-depth env isolation: require the connector to be in this env. */
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const { connectorIds, queryText, userAcl, bypassAcl = false } = params;
    if (connectorIds.length === 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];

    const terms = queryText.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    if (params.ranking === "bm25") {
      // Same AND-first, OR-fallback contract as the ts_rank path below, in
      // pg_search operators: `&&&` requires every token, `|||` matches any.
      // Ranking is BM25 (pdb.score) in both passes, so the fallback only
      // widens the match set — the loose precision is absorbed downstream by
      // RRF and the reranker, exactly as for the ts_rank OR fallback.
      const andRows = await KbChunkModel.runBm25Statement({
        ...params,
        matchAllTerms: true,
      });
      if (andRows.length > 0 || terms.length <= 1) return andRows;
      return KbChunkModel.runBm25Statement({
        ...params,
        matchAllTerms: false,
      });
    }

    // AND-first, OR-fallback. The query text goes to websearch_to_tsquery
    // as written, whose natural semantics AND the plain terms — a selective
    // match set the GIN index serves with a bitmap scan. The previous
    // always-OR rewrite matched ~40% of a 113k-chunk corpus (measured via
    // EXPLAIN on that corpus): at that selectivity the planner rightly
    // abandons the GIN for a parallel seq scan and ts_rank detoasts every
    // match — ~7.6s per statement, growing with the corpus, which is what
    // drove the keyword lane into the statement timeout. The OR form
    // survives only as a recall fallback when the AND query matches nothing
    // (no chunk holds every term), where RRF and the reranker downstream
    // absorb its loose precision.
    const andRows = await KbChunkModel.runFullTextStatement({
      ...params,
      tsQueryText: queryText,
    });
    if (andRows.length > 0 || terms.length <= 1) return andRows;

    return KbChunkModel.runFullTextStatement({
      ...params,
      tsQueryText: terms.join(" OR "),
    });
  }

  /**
   * Fetch the chunks surrounding a set of search hits, for context expansion.
   *
   * Re-applies the full ACL, environment, and soft-delete filters rather than
   * trusting that a neighbour of a visible chunk is itself visible: chunk ACLs
   * are per-row and a permission-sync pass can legitimately leave two chunks of
   * one document with different audiences. A neighbour the user cannot read is
   * simply absent from the result.
   *
   * Media chunks (base64 data URLs) are excluded — stitching one into a prose
   * neighbour would emit megabytes of base64 into the model's context.
   */
  static async findNeighbors(params: {
    /** The hits to expand around, as (documentId, chunkIndex) pairs. */
    anchors: Array<{ documentId: string; chunkIndex: number }>;
    radius: number;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
  }): Promise<
    Array<{
      id: string;
      documentId: string;
      chunkIndex: number;
      content: string;
    }>
  > {
    const {
      anchors,
      radius,
      userAcl,
      bypassAcl = false,
      environmentId,
    } = params;
    if (anchors.length === 0 || radius <= 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];

    // Explicit (documentId, chunkIndex) pairs rather than per-document ranges:
    // the pair list is bounded by anchors x 2*radius and lets Postgres use the
    // document_id index without over-fetching a whole document.
    const pairs: Array<{ documentId: string; chunkIndex: number }> = [];
    const seen = new Set<string>();
    for (const anchor of anchors) {
      for (
        let index = anchor.chunkIndex - radius;
        index <= anchor.chunkIndex + radius;
        index++
      ) {
        if (index < 0 || index === anchor.chunkIndex) continue;
        const key = `${anchor.documentId}:${index}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ documentId: anchor.documentId, chunkIndex: index });
      }
    }
    if (pairs.length === 0) return [];

    const pairList = sql.join(
      pairs.map((p) => sql`(${p.documentId}::uuid, ${p.chunkIndex})`),
      sql`, `,
    );
    const documentIds = sql.join(
      [...new Set(pairs.map((p) => p.documentId))].map(
        (id) => sql`${id}::uuid`,
      ),
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

    const rows = await db.execute(sql`
      SELECT
        c.id, c.document_id AS "documentId",
        c.chunk_index AS "chunkIndex", c.content
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE c.document_id IN (${documentIds})
        AND (c.document_id, c.chunk_index) IN (${pairList})
        AND kbc.deleted_at IS NULL
        AND c.content NOT LIKE 'data:image/%'
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
    `);

    return rows.rows as unknown as Array<{
      id: string;
      documentId: string;
      chunkIndex: number;
      content: string;
    }>;
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

  private static async runFullTextStatement(params: {
    connectorIds: string[];
    /** The text handed to websearch_to_tsquery, verbatim. */
    tsQueryText: string;
    languages?: TextSearchLanguage[];
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const {
      connectorIds,
      tsQueryText,
      languages,
      userAcl,
      bypassAcl = false,
      environmentId,
      limit = 10,
    } = params;
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

    // The query is parsed once per text-search configuration present, and the
    // per-language predicates are OR-ed together.
    //
    // The obvious formulation — `websearch_to_tsquery(c.fts_language, ...)`,
    // matching each chunk under its own stored configuration — is a per-row
    // expression, so PostgreSQL cannot constant-fold it into an index lookup
    // key and the GIN index on search_vector becomes unusable. Measured on a
    // 300k-chunk corpus that turned a bitmap index scan into a full sequential
    // scan: ~18 buffers to ~14,000, growing with the corpus rather than with
    // the number of matches, on the keyword leg of every hybrid query.
    //
    // Each branch here uses a literal configuration, so each is index-driven
    // and PostgreSQL combines them with a BitmapOr. A single-language corpus —
    // the common case — collapses to exactly one indexed predicate.
    //
    // A chunk is therefore matched under every configuration present, not only
    // its own. In a mixed-language corpus that trades a little precision for
    // recall, which RRF and the reranker downstream are well placed to absorb;
    // the alternative failure (a chunk matched under no configuration at all,
    // and so invisible to keyword search) is far worse.
    const searchLanguages =
      languages && languages.length > 0
        ? languages
        : [DEFAULT_TEXT_SEARCH_LANGUAGE];

    // Bound parameters, not interpolated literals: a bound `regconfig` is still
    // constant at execution time, so it stays index-eligible, and nothing from
    // the column reaches the SQL text.
    const matchPredicate = sql.join(
      searchLanguages.map(
        (language) =>
          sql`c.search_vector @@ websearch_to_tsquery(${language}::regconfig, ${tsQueryText})`,
      ),
      sql` OR `,
    );
    // Rank under the best-matching configuration, so a chunk is not penalized
    // for the languages it is not written in.
    const scoreExpression = sql.join(
      searchLanguages.map(
        (language) =>
          sql`ts_rank(c.search_vector, websearch_to_tsquery(${language}::regconfig, ${tsQueryText}))`,
      ),
      sql`, `,
    );

    const rows = await executeWithSearchTimeout(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        GREATEST(${scoreExpression}) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        -- Mirrors the same guard in vectorSearch: retrieval is a security
        -- surface, so never serve chunks from a soft-deleted connector even if
        -- a stale connectorId reaches this far.
        AND kbc.deleted_at IS NULL
        AND (${matchPredicate})
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
      ORDER BY score DESC
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }

  /**
   * The BM25 keyword statement (pg_search). Matches one expression containing
   * the same text as the generated tsvector — contextual header, content, and
   * keyword metadata — then ranks with length-normalized, term-saturating,
   * IDF-weighted `pdb.score` (issue #7158).
   */
  private static async runBm25Statement(params: {
    connectorIds: string[];
    queryText: string;
    /** `true` = every token must match (`&&&`); `false` = any token (`|||`). */
    matchAllTerms: boolean;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const {
      connectorIds,
      queryText,
      matchAllTerms,
      userAcl,
      bypassAcl = false,
      environmentId,
      limit = 10,
    } = params;
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

    // Normalize query lexemes with the same PostgreSQL English parser used by
    // search_vector. This preserves its stemming and complete stopword list;
    // ParadeDB's English stopword list differs (for example, it keeps "what").
    // The resulting plain lexeme string is still bound data, not query syntax.
    const normalizedQuery = sql`
      array_to_string(
        tsvector_to_array(
          to_tsvector(${DEFAULT_TEXT_SEARCH_LANGUAGE}::regconfig, ${queryText})
        ),
        ' '
      )
    `;
    const matchOperator = matchAllTerms ? sql.raw("&&&") : sql.raw("|||");
    const searchableText = sql`
      COALESCE(c.contextual_header, '') || ' ' ||
      c.content || ' ' ||
      COALESCE(c.metadata_suffix_keyword, '')
    `;
    const matchPredicate = sql`(${searchableText}) ${matchOperator} ${normalizedQuery}`;

    const rows = await executeWithSearchTimeout(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        pdb.score(c.id) AS score
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE d.connector_id IN (${ids})
        -- Matches the BM25 partial-index predicate. Media chunks are base64
        -- image payloads intended for vector retrieval, not keyword search.
        AND c.content NOT LIKE 'data:image/%'
        -- Mirrors the same guard in vectorSearch: retrieval is a security
        -- surface, so never serve chunks from a soft-deleted connector even if
        -- a stale connectorId reaches this far.
        AND kbc.deleted_at IS NULL
        AND ${matchPredicate}
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
      ORDER BY score DESC, c.id ASC
      LIMIT ${limit}
    `);

    return rows.rows as unknown as VectorSearchResult[];
  }
}

export default KbChunkModel;

// === Internal helpers ===

/**
 * Run a search statement under the KB-specific statement timeout
 * ({@link config.kb.searchStatementTimeoutMillis}), leaving the pool-wide
 * statement_timeout in force for everything else. SET LOCAL semantics via
 * set_config(..., true) scope the override to the wrapping transaction, and
 * set_config takes the value as a bound parameter (plain SET cannot).
 */
async function executeWithSearchTimeout(query: SQL) {
  const timeoutMillis = config.kb.searchStatementTimeoutMillis;
  if (timeoutMillis <= 0) return db.execute(query);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${String(timeoutMillis)}, true)`,
    );
    return tx.execute(query);
  });
}
