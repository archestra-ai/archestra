import {
  DEFAULT_TEXT_SEARCH_LANGUAGE,
  getEmbeddingColumnName,
  type TextSearchLanguage,
} from "@archestra/shared";
import { count, eq, type SQL, sql } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import type { AclEntry, InsertKbChunk, KbChunk } from "@/types";

/**
 * BM25 tuning constants for one query. Resolved per organization by the query
 * service (an organization's Knowledge-settings override, else the deployment
 * default from config), and passed down rather than read here so the ranker
 * stays a pure function of its inputs.
 *
 * Okapi BM25 computed in plain SQL from the corpus statistics in
 * `kb_bm25_term_stats` and `kb_bm25_corpus_stats` (no extension, no extra
 * index on `kb_chunks`) is the keyword ranker. PostgreSQL's built-in `ts_rank`
 * runs only while those statistics do not exist yet — the query service checks
 * {@link KbChunkModel.hasBm25Stats} and omits the constants until then.
 */
export interface Bm25Tuning {
  /** Term-frequency saturation; 0 makes a term binary (present/absent). */
  k1: number;
  /** Document-length normalization in [0, 1]; 0 ignores chunk length. */
  b: number;
}

export interface VectorSearchResult {
  id: string;
  content: string;
  chunkIndex: number;
  /**
   * The passage this chunk was sliced out of, or `null` when the chunk IS the
   * passage. Retrieval reads it to decide whether a hit resolves to a parent
   * passage or is widened by context expansion instead.
   */
  parentIndex: number | null;
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
    const rows = await executeWithSearchTimeout(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        c.parent_index AS "parentIndex",
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
   * Re-hydrate candidates from an external retrieval backend and apply every
   * security predicate in PostgreSQL. Candidate content and citation fields
   * are deliberately ignored: only the backend's rank and stable chunk id are
   * trusted. This keeps ACL, environment isolation, and soft-delete filtering
   * under Archestra's control even when ranking runs outside PostgreSQL.
   */
  static async verifyExternalSearchResults(params: {
    candidates: VectorSearchResult[];
    connectorIds: string[];
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
  }): Promise<VectorSearchResult[]> {
    const {
      candidates,
      connectorIds,
      userAcl,
      bypassAcl = false,
      environmentId,
    } = params;
    if (candidates.length === 0 || connectorIds.length === 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];

    const candidateIds = sql.join(
      [...new Set(candidates.map((candidate) => candidate.id))].map(
        (id) => sql`${id}::uuid`,
      ),
      sql`, `,
    );
    const scopedConnectorIds = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const aclEntries = bypassAcl
      ? null
      : sql.join(
          userAcl.map((entry) => sql`${entry}`),
          sql`, `,
        );
    const environmentFilter =
      environmentId !== undefined
        ? sql`AND kbc.environment_id IS NOT DISTINCT FROM ${environmentId}`
        : sql``;

    const rows = await db.execute(sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex",
        c.parent_index AS "parentIndex",
        c.document_id AS "documentId", d.source_id AS "sourceId", d.title,
        d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType"
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE c.id IN (${candidateIds})
        AND d.connector_id IN (${scopedConnectorIds})
        AND kbc.deleted_at IS NULL
        ${environmentFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
    `);

    const verifiedById = new Map(
      (rows.rows as Array<Omit<VectorSearchResult, "score">>).map((row) => [
        row.id,
        row,
      ]),
    );
    return candidates.flatMap((candidate) => {
      const verified = verifiedById.get(candidate.id);
      return verified ? [{ ...verified, score: candidate.score }] : [];
    });
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
        bool_or(c.embedding_3072 IS NOT NULL) AS "d3072",
        bool_or(c.embedding_1408 IS NOT NULL) AS "d1408"
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
      if (row.d1408) dimensions.add(1408);
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

  static async fullTextSearch(params: {
    connectorIds: string[];
    queryText: string;
    /**
     * Text-search configurations to parse the query under, from
     * {@link getTextSearchLanguages}. Empty falls back to the column default.
     */
    languages?: TextSearchLanguage[];
    /**
     * BM25 constants to score with. Left unset, the statement ranks with
     * PostgreSQL's `ts_rank` instead — which the query service does only while
     * the BM25 statistics are not built yet (see {@link hasBm25Stats}); the BM25
     * statement itself also uses `ts_rank` to pick its candidate set (see
     * {@link buildSqlBm25Statement}).
     */
    bm25?: Bm25Tuning;
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
      // The OR form is tsquery syntax, not text to score against: BM25 parses
      // its scored terms with to_tsvector, where "OR" is a stopword only in
      // some configurations — under `simple` or `german` it survives as a
      // lexeme, and being rare it carries a large IDF, so a chunk that happens
      // to contain "or" would get a sizeable phantom boost. Score against what
      // the user actually asked.
      lexemeText: queryText,
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

  /**
   * Every child chunk of the given parent passages, for reassembling the
   * passage behind a search hit.
   *
   * ACL-filtered per row exactly like {@link KbChunkModel.findNeighbors}: a
   * permission pass can legitimately leave two chunks of one document with
   * different audiences, so a sibling the user cannot read is simply absent and
   * the passage is served without it. Media chunks are excluded on the same
   * grounds — a base64 data URL stitched into prose is megabytes of noise.
   *
   * Ordered by `chunk_index` so callers can stitch without re-sorting.
   */
  static async findParentSiblings(params: {
    parents: Array<{ documentId: string; parentIndex: number }>;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
  }): Promise<
    Array<{
      id: string;
      documentId: string;
      parentIndex: number;
      chunkIndex: number;
      content: string;
    }>
  > {
    const { parents, userAcl, bypassAcl = false, environmentId } = params;
    if (parents.length === 0) return [];
    if (!bypassAcl && userAcl.length === 0) return [];

    const seen = new Set<string>();
    const unique: Array<{ documentId: string; parentIndex: number }> = [];
    for (const parent of parents) {
      const key = `${parent.documentId}:${parent.parentIndex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(parent);
    }

    // Explicit (document_id, parent_index) pairs so the partial index on those
    // two columns is usable, rather than a per-document scan that would pull in
    // every other passage of a long document.
    const pairList = sql.join(
      unique.map((p) => sql`(${p.documentId}::uuid, ${p.parentIndex})`),
      sql`, `,
    );
    const documentIds = sql.join(
      [...new Set(unique.map((p) => p.documentId))].map(
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
        c.parent_index AS "parentIndex",
        c.chunk_index AS "chunkIndex", c.content
      FROM kb_chunks c
      JOIN kb_documents d ON d.id = c.document_id
      LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      WHERE c.document_id IN (${documentIds})
        AND c.parent_index IS NOT NULL
        AND (c.document_id, c.parent_index) IN (${pairList})
        AND kbc.deleted_at IS NULL
        AND c.content NOT LIKE 'data:image/%'
        ${envFilter}
        ${bypassAcl ? sql`` : sql`AND c.acl ?| ARRAY[${aclEntries}]`}
      ORDER BY c.document_id, c.parent_index, c.chunk_index
    `);

    return rows.rows as unknown as Array<{
      id: string;
      documentId: string;
      parentIndex: number;
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
    /**
     * The text BM25 parses its scored terms from. Defaults to `tsQueryText`
     * and differs only for the OR-fallback, whose operators are not query
     * terms.
     */
    lexemeText?: string;
    languages?: TextSearchLanguage[];
    bm25?: Bm25Tuning;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    environmentId?: string | null;
    limit?: number;
  }): Promise<VectorSearchResult[]> {
    const {
      connectorIds,
      tsQueryText,
      languages,
      bm25,
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

    // The matched set, with every filter applied. Shared verbatim by both
    // rankers: these predicates are a security surface (ACL, soft-deleted
    // connector, environment isolation), so there is exactly one copy of them
    // and the BM25 ranker cannot drift from it. It also fixes the ordering
    // that matters — filters run BEFORE any recall cap below, so capping can
    // never hand a user a shorter list than their permissions allow.
    const matchedSet = sql`
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
    `;

    const statement = bm25
      ? KbChunkModel.buildSqlBm25Statement({
          matchedSet,
          scoreExpression,
          lexemeText: params.lexemeText ?? tsQueryText,
          limit,
          tuning: bm25,
        })
      : sql`
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        c.parent_index AS "parentIndex",
        d.source_id AS "sourceId", d.title, d.source_url AS "sourceUrl", d.metadata,
        kbc.connector_type AS "connectorType",
        GREATEST(${scoreExpression}) AS score
      ${matchedSet}
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    const rows = await executeWithSearchTimeout(statement);

    return rows.rows as unknown as VectorSearchResult[];
  }

  /**
   * Rebuild the BM25 corpus statistics from `kb_chunks`.
   *
   * `ts_stat()` does the expensive part: it walks the corpus and returns
   * document frequency per lexeme, which is precisely BM25's `df`. Running it
   * once per text-search configuration keeps German stems counted against the
   * German corpus and English against English — pooling them would compute IDF
   * over a corpus that does not exist.
   *
   * Replaced with DELETE + INSERT in one transaction rather than TRUNCATE: a
   * TRUNCATE takes ACCESS EXCLUSIVE and would block every concurrent keyword
   * query for the whole rebuild, while under MVCC the DELETE lets readers keep
   * the previous snapshot until commit.
   *
   * Read-only against `kb_chunks`, so it never blocks ingestion.
   */
  static async refreshBm25Stats(): Promise<{
    languages: number;
    terms: number;
  }> {
    return db.transaction(async (tx) => {
      // The pool's statement_timeout is sized for request-path queries
      // (30s by default), and this is a full corpus scan whose cost grows with
      // the corpus — past roughly half a million chunks it would be killed
      // mid-rebuild, every hour, forever, leaving every search on the ts_rank
      // fallback with nothing but a settings-page flag to show for it. Raise
      // it for this transaction only.
      await tx.execute(
        sql`SELECT set_config('statement_timeout', ${String(config.kb.bm25StatsRefreshTimeoutMillis)}, true)`,
      );
      // Serialize overlapping rebuilds (a run the stuck-task sweep re-queued
      // while the original is still going, for instance). The second waits for
      // the first to commit, then sees its rows and replaces them, instead of
      // racing the DELETE and failing on duplicate keys. Transaction-scoped, so
      // it releases with the commit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('kb_bm25_stats_refresh'))`,
      );
      await tx.execute(sql`
        CREATE TEMP TABLE kb_bm25_term_stats_next
          ON COMMIT DROP
          AS SELECT
               language.fts_language,
               stat.word AS term,
               stat.ndoc::bigint AS df
             FROM (
               SELECT DISTINCT fts_language::text AS fts_language FROM kb_chunks
             ) language
             CROSS JOIN LATERAL ts_stat(
               format(
                 'SELECT search_vector FROM kb_chunks WHERE fts_language::text = %L',
                 language.fts_language
               )
             ) stat
      `);

      // DELETE + INSERT rather than TRUNCATE: under MVCC, concurrent readers
      // keep seeing the previous snapshot until this transaction commits, so
      // the keyword lane never observes an empty statistics table mid-rebuild.
      await tx.execute(sql`DELETE FROM kb_bm25_term_stats`);
      const inserted = await tx.execute(sql`
        INSERT INTO kb_bm25_term_stats (fts_language, term, df)
        SELECT fts_language, term, df FROM kb_bm25_term_stats_next
      `);

      await tx.execute(sql`DELETE FROM kb_bm25_corpus_stats`);
      const languages = await tx.execute(sql`
        INSERT INTO kb_bm25_corpus_stats (fts_language, n_docs, avg_dl)
        SELECT fts_language::text, count(*)::bigint, avg(tok_len)::numeric
        FROM kb_chunks
        WHERE tok_len IS NOT NULL
        GROUP BY fts_language::text
        -- A configuration with no measurable length would make every score
        -- divide by zero; skip it and leave that language on ts_rank.
        HAVING avg(tok_len) > 0
      `);

      return {
        languages: languages.rowCount ?? 0,
        terms: inserted.rowCount ?? 0,
      };
    });
  }

  /**
   * Whether BM25 can actually rank this query right now.
   *
   * Every term the query parses to is scored against the statistics for the
   * chunk's own configuration, so a configuration whose statistics do not
   * exist yet scores nothing meaningful — a freshly upgraded deployment would
   * rank as if the corpus were empty. The query service checks this and ranks
   * with `ts_rank` until the first rebuild has run.
   *
   * A configuration with no indexed chunks is harmless and must NOT block
   * BM25: it contributes no rows either way, and `ts_stat` never produces
   * statistics for it, so blocking on it would disable BM25 permanently
   * rather than until the next rebuild. That is not hypothetical — a
   * connector created in a language nothing has been indexed in yet puts its
   * language on this list from the moment it exists.
   *
   * Chunks left in a configuration no connector claims any more are handled
   * in the statement itself (deployment-wide totals stand in), not here: a
   * check for them would have to prove that NO chunk of the searched
   * connectors lacks statistics, which means reading every one of them on
   * every search — `fts_language` carries no index, and the healthy case is
   * exactly the case that cannot short-circuit.
   */
  static async hasBm25Stats(
    languages: TextSearchLanguage[],
    connectorIds: string[],
  ): Promise<boolean> {
    if (connectorIds.length === 0) return false;
    const wanted =
      languages.length > 0 ? languages : [DEFAULT_TEXT_SEARCH_LANGUAGE];
    const names = sql.join(
      wanted.map((language) => sql`${language}`),
      sql`, `,
    );
    // One small read against the statistics tables (one row per configuration)
    // on the healthy path. Nothing here touches kb_chunks: a check that had to
    // prove NO chunk lacks statistics would have to scan every chunk of every
    // searched connector on every search, and `fts_language` carries no index.
    const result = await db.execute(sql`
      SELECT fts_language AS "language"
      FROM kb_bm25_corpus_stats
      WHERE fts_language IN (${names}) AND n_docs > 0
    `);
    const covered = new Set(
      (result.rows as Array<{ language: string }>).map((row) => row.language),
    );
    const missing = wanted.filter((language) => !covered.has(language));
    if (missing.length === 0) return true;

    // Something is uncovered. It only matters if chunks are actually stored in
    // it — a connector created in a language nothing has been indexed in yet
    // never gets statistics (`ts_stat` only sees languages that have chunks),
    // so blocking on it would disable BM25 permanently rather than until the
    // next rebuild. This EXISTS stops at the first matching row, and the case
    // it has to scan for (no chunks at all in that language) is the rare one.
    const ids = sql.join(
      connectorIds.map((id) => sql`${id}`),
      sql`, `,
    );
    const missingNames = sql.join(
      missing.map((language) => sql`${language}`),
      sql`, `,
    );
    const probe = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM kb_documents d
        JOIN kb_chunks c ON c.document_id = d.id
        WHERE d.connector_id IN (${ids})
          AND c.fts_language::text IN (${missingNames})
      ) AS "present"
    `);
    return !(
      (probe.rows[0] as { present: boolean } | undefined)?.present ?? false
    );
  }

  /**
   * Whether the organization has any indexed chunk at all — the difference
   * between "nothing to rank yet" and "ranking". Kept separate from
   * {@link getBm25StatsCoverage} because chunks can sit in a language no
   * connector currently claims (a connector whose language was changed after
   * indexing), which is still indexed content.
   */
  static async hasIndexedChunks(organizationId: string): Promise<boolean> {
    const result = await db.execute(sql`
      SELECT EXISTS (
        SELECT 1
        FROM kb_documents d
        JOIN kb_chunks c ON c.document_id = d.id
        WHERE d.organization_id = ${organizationId}
      ) AS "present"
    `);
    return (
      (result.rows[0] as { present: boolean } | undefined)?.present ?? false
    );
  }

  /**
   * BM25 statistics coverage for everything an organization can search: one
   * row per text-search configuration its connectors use, with whether chunks
   * are actually stored in that configuration and whether statistics exist for
   * it. Knowledge settings turns this into the keyword-ranking status.
   *
   * The two flags mirror {@link hasBm25Stats} exactly, so the status can never
   * claim BM25 is ranking while queries fall back: chunks-and-no-statistics is
   * the degraded state, and a language with no chunks never blocks anything.
   *
   * Candidate languages come from the connector rows (small, indexed by
   * organization); chunk presence is an EXISTS probe through
   * `kb_documents(connector_id)` and `kb_chunks(document_id)`, keyed by the
   * chunk's own language.
   */
  static async getBm25StatsCoverage(organizationId: string): Promise<
    Array<{
      language: TextSearchLanguage;
      hasChunks: boolean;
      hasStats: boolean;
    }>
  > {
    const result = await db.execute(sql`
      SELECT
        kbc.fts_language AS language,
        EXISTS (
          SELECT 1
          FROM kb_documents d
          JOIN kb_chunks c ON c.document_id = d.id
          WHERE d.connector_id IN (
            SELECT id FROM knowledge_base_connectors
            WHERE organization_id = ${organizationId} AND deleted_at IS NULL
          )
          AND c.fts_language::text = kbc.fts_language
        ) AS "hasChunks",
        EXISTS (
          SELECT 1 FROM kb_bm25_corpus_stats s
          WHERE s.fts_language = kbc.fts_language AND s.n_docs > 0
        ) AS "hasStats"
      FROM (
        SELECT DISTINCT fts_language
        FROM knowledge_base_connectors
        WHERE organization_id = ${organizationId} AND deleted_at IS NULL
      ) kbc
      ORDER BY kbc.fts_language
    `);
    return result.rows as Array<{
      language: TextSearchLanguage;
      hasChunks: boolean;
      hasStats: boolean;
    }>;
  }

  /**
   * Okapi BM25 over the same matched set, in plain SQL.
   *
   * Two stages, because BM25 is a scoring function and not an index. Stage one
   * is recall: the GIN index on `search_vector` produces candidates, ordered by
   * `ts_rank` and capped. Stage two rescores those candidates properly.
   *
   * The cap is the one approximation here, and it is a deliberate dial. Scoring
   * is linear in candidates (~0.03 ms each, measured on a 60k-chunk corpus), so
   * an uncapped broad query matching half the corpus costs over a second, while
   * capping keeps the worst case bounded. Uncapped, this returns byte-identical
   * top-10 rankings to ParadeDB's `pg_search` on the same corpus; capped, it
   * can only reorder what `ts_rank` already surfaced. Raise
   * `config.kb.bm25RecallCap` to trade latency back for fidelity.
   *
   * Everything is keyed by the CHUNK's own `fts_language`, not the query's:
   * a German chunk stores German stems, so it must be scored with German query
   * lexemes against German corpus statistics. `fts_language` is `regconfig` on
   * `kb_chunks` and `text` in the statistics tables, and PostgreSQL will not
   * coerce between them — hence the explicit `::text`.
   */
  private static buildSqlBm25Statement(params: {
    matchedSet: SQL;
    scoreExpression: SQL;
    /** The text the scored query terms are parsed from. */
    lexemeText: string;
    limit: number;
    tuning: Bm25Tuning;
  }): SQL {
    const {
      matchedSet,
      scoreExpression,
      lexemeText,
      limit,
      tuning: { k1, b },
    } = params;
    const { bm25RecallCap: recallCap } = config.kb;

    return sql`
      WITH candidate_ids AS (
        -- Ids only. The sort that picks the candidate window has to carry its
        -- payload through, and content and search_vector are toasted: selecting
        -- them here made PostgreSQL spill the whole matched set to an external
        -- merge sort (measured on a 60k-chunk corpus: 55 MB of sort space and
        -- ~115 MB of temp blocks, against 26 kB for a bounded top-N heapsort).
        -- The columns are joined back for the capped window instead.
        SELECT c.id
        ${matchedSet}
        -- c.id after the score: equally-ranked chunks at the cap boundary would
        -- otherwise be admitted in whatever order the plan produced, so the same
        -- query could return different results run to run.
        ORDER BY GREATEST(${scoreExpression}) DESC, c.id ASC
        LIMIT ${recallCap}
      ),
      candidates AS (
        SELECT
          c.id, c.content, c.chunk_index, c.parent_index, c.document_id,
          c.search_vector, c.tok_len, c.fts_language,
          d.source_id, d.title, d.source_url, d.metadata,
          kbc.connector_type
        FROM candidate_ids
        JOIN kb_chunks c ON c.id = candidate_ids.id
        JOIN kb_documents d ON d.id = c.document_id
        LEFT JOIN knowledge_base_connectors kbc ON kbc.id = d.connector_id
      ),
      -- Query lexemes per configuration actually present in the candidate set,
      -- not per configuration the caller passed. A chunk keeps the language it
      -- was indexed under, so a connector switched to another one afterwards
      -- still holds chunks in the old configuration; parsing the query only in
      -- the connector's current language would leave those candidates with no
      -- term to match and drop them from the keyword lane entirely.
      --
      -- Normalizing through to_tsvector (rather than splitting the raw text)
      -- applies the same stemmer and stopword list that built search_vector, so
      -- query lexemes and indexed lexemes are directly comparable.
      query_terms AS (
        SELECT
          language.fts_language,
          unnest(tsvector_to_array(
            to_tsvector(language.fts_language, ${lexemeText})
          )) AS term
        FROM (SELECT DISTINCT fts_language FROM candidates) language
      )
      SELECT
        c.id, c.content, c.chunk_index AS "chunkIndex", c.document_id AS "documentId",
        c.parent_index AS "parentIndex",
        c.source_id AS "sourceId", c.title, c.source_url AS "sourceUrl", c.metadata,
        c.connector_type AS "connectorType",
        -- Cast to double precision, not the bare numeric this sum produces:
        -- the driver decodes numeric as a STRING, so a BM25 row would carry a
        -- string score where the ts_rank path (float8) carries a number, and
        -- both feed one fused list typed as number.
        SUM(
          -- IDF, log(1 + …) variant: strictly positive, so a term present in
          -- most of the corpus stops contributing rather than subtracting.
          -- The textbook form goes negative there, which would rank a chunk
          -- BELOW one that omits the term entirely. Matches the variant the
          -- tool-search BM25F already uses.
          -- GREATEST guards the numerator: df and n_docs are written by two
          -- separate statements of the rebuild, so a deletion landing between
          -- them can leave df > n_docs. Unguarded, that makes the logarithm's
          -- argument non-positive and PostgreSQL aborts the whole keyword
          -- query ("cannot take logarithm of a negative number").
          ln(1 + (GREATEST(corpus.n_docs - COALESCE(ts.df, 0), 0) + 0.5)
                 / (COALESCE(ts.df, 0) + 0.5))
          -- Term-frequency saturation: the 10th occurrence adds almost nothing.
          -- Every tuning constant is cast explicitly: PostgreSQL infers a bound
          -- parameter's type from its context and picks integer here, which
          -- rejects the fractional defaults (k1=1.2, b=0.75) outright.
          * (tf.tf * (${k1}::numeric + 1))
          / (
            tf.tf
            + ${k1}::numeric * (
              1 - ${b}::numeric
              -- Length normalization: a hit in a short chunk is stronger
              -- evidence than the same hit in a long one.
              + ${b}::numeric * (c.tok_len::numeric / NULLIF(corpus.avg_dl, 0))
            )
          )
        )::double precision AS score
      FROM candidates c
      -- LEFT, with deployment-wide totals standing in: a chunk stored under a
      -- configuration that has no statistics row (a connector whose language
      -- was changed after indexing leaves chunks behind in the old one) would
      -- otherwise be dropped by an inner join — silently returning FEWER
      -- results than the fallback ranker would have. Approximate totals for
      -- one refresh interval beat losing the chunk.
      LEFT JOIN kb_bm25_corpus_stats cs ON cs.fts_language = c.fts_language::text
      CROSS JOIN LATERAL (
        SELECT
          -- Deployment-wide totals stand in for a configuration with no row of
          -- its own; the trailing constants keep the score finite even with an
          -- empty statistics table, where avg_dl = this chunk's own length
          -- makes length normalization neutral rather than undefined.
          COALESCE(cs.n_docs, (SELECT sum(n_docs) FROM kb_bm25_corpus_stats), 1) AS n_docs,
          COALESCE(cs.avg_dl, (SELECT avg(avg_dl) FROM kb_bm25_corpus_stats), c.tok_len::numeric) AS avg_dl
      ) corpus
      JOIN LATERAL unnest(c.search_vector) u ON true
      JOIN query_terms q
        ON q.fts_language = c.fts_language AND q.term = u.lexeme
      -- LEFT, not INNER: a lexeme indexed since the last statistics rebuild has
      -- no row here. Dropping the pair would drop the chunk from the keyword
      -- lane whenever every matched term is new — exactly the case of searching
      -- for an identifier in a document that was just ingested. Absent from the
      -- statistics means "in no counted document", which is what df = 0 says,
      -- and the IDF term above then treats it as maximally rare.
      LEFT JOIN kb_bm25_term_stats ts
        ON ts.fts_language = c.fts_language::text AND ts.term = u.lexeme
      -- A lexeme with no positions (a stripped tsvector) still occurred once.
      CROSS JOIN LATERAL (
        SELECT COALESCE(array_length(u.positions, 1), 1)::numeric AS tf
      ) tf
      WHERE c.tok_len IS NOT NULL
      GROUP BY
        c.id, c.content, c.chunk_index, c.parent_index, c.document_id,
        c.source_id, c.title, c.source_url, c.metadata, c.connector_type
      -- c.id breaks ties deterministically, so pagination and the eval
      -- harness see a stable order for equally-scored chunks.
      ORDER BY score DESC, c.id ASC
      LIMIT ${limit}
    `;
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
