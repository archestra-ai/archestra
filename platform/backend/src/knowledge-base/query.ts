import { addNomicTaskPrefix, type TextSearchLanguage } from "@archestra/shared";
import config from "@/config";
import { isDbStatementTimeoutError } from "@/database/retry";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { expandChunkContext } from "./context-expansion";
import { callEmbedding, getEmbeddingDiscriminator } from "./embedding-clients";
import {
  EmbeddingDimensionMismatchError,
  KnowledgeBaseSearchTimeoutError,
  normalizeEmbeddingError,
} from "./errors";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import { type EmbeddingConfig, resolveEmbeddingConfig } from "./kb-llm-client";
import {
  expandQuery,
  KEYWORD_QUERY_HYBRID_ALPHA_WEIGHT,
} from "./query-expansion";
import { buildChunkRef } from "./quote-verification";
import rerank from "./reranker";
import reciprocalRankFusion from "./rrf";

interface ChunkResult {
  content: string;
  score: number;
  chunkIndex: number;
  metadata: Record<string, unknown> | null;
  /**
   * Stable, model-visible citation anchor (`documentId#chunkIndex`). The model
   * is asked to tag verbatim quotes with it, and quote verification matches a
   * quote back against the chunk it names. Derived, not stored — no schema
   * change.
   */
  ref: string;
  citation: {
    title: string;
    sourceUrl: string | null;
    documentId: string;
    sourceId: string | null;
    connectorType: string | null;
  };
}

class QueryService {
  async query(params: {
    connectorIds: string[];
    organizationId: string;
    queryText: string;
    userAcl: AclEntry[];
    bypassAcl?: boolean;
    /**
     * Defense-in-depth environment isolation. When provided (incl. `null` =
     * Default), the chunk search also requires the chunk's connector to be in
     * this environment, so a stray cross-env connectorId cannot leak results.
     */
    environmentId?: string | null;
    limit?: number;
  }): Promise<ChunkResult[]> {
    const {
      connectorIds,
      organizationId,
      queryText,
      bypassAcl = false,
      environmentId,
      limit = 10,
    } = params;
    if (connectorIds.length === 0) return [];
    if (!bypassAcl && params.userAcl.length === 0) return [];

    const queryStartTime = Date.now();
    const hybridEnabled = config.kb.hybridSearchEnabled;
    const overFetchLimit = hybridEnabled ? limit * 2 : limit;

    const embeddingConfig = await resolveEmbeddingConfig(organizationId);
    if (!embeddingConfig) {
      logger.warn(
        { organizationId, connectorIds },
        "[QueryService] No embedding API key configured, cannot query",
      );
      return [];
    }

    // A query scoped to one connector attributes its LLM calls to it; a fan-out
    // across several has no single connector to name.
    const connectorId = connectorIds.length === 1 ? connectorIds[0] : null;

    // Resolved once and passed down: the keyword search needs the languages as
    // bound parameters to keep its tsquery index-eligible (see fullTextSearch).
    const [expandedQueries, searchLanguages] = await Promise.all([
      expandQuery({ queryText, organizationId, connectorId }),
      hybridEnabled
        ? KbChunkModel.getTextSearchLanguages(connectorIds)
        : Promise.resolve([]),
    ]);

    const perQueryResults = await Promise.all(
      expandedQueries.map((eq) =>
        this.searchSingleQuery({
          queryText: eq.queryText,
          embeddingConfig,
          connectorIds,
          connectorId,
          limit: overFetchLimit,
          userAcl: params.userAcl,
          bypassAcl,
          environmentId,
          type: eq.type,
          hybridEnabled,
          searchLanguages,
        }),
      ),
    );

    // Search-lane degradation: a lane cut by the statement timeout was dropped
    // (logged + metered in searchSingleQuery) and the rest merged. Only when
    // EVERY lane of every expanded query timed out is there genuinely nothing
    // to serve — surface that as an actionable error rather than an empty
    // result a caller would read as "no matching documents".
    const lanesAttempted = perQueryResults.reduce(
      (n, r) => n + r.lanesAttempted,
      0,
    );
    const lanesTimedOut = perQueryResults.reduce(
      (n, r) => n + r.lanesTimedOut,
      0,
    );
    if (lanesAttempted > 0 && lanesTimedOut === lanesAttempted) {
      throw new KnowledgeBaseSearchTimeoutError(
        config.kb.searchStatementTimeoutMillis ||
          config.database.statementTimeoutMillis,
      );
    }

    const weights = expandedQueries.map((eq) => eq.weight);

    const merged = reciprocalRankFusion<VectorSearchResult>({
      rankings: perQueryResults.map((r) => r.rows),
      idExtractor: (row) => row.id,
      weights,
      k: 50,
    });

    // Empty results can mean "no matching documents" (normal) OR that the
    // documents were ingested at a different embedding dimension than the one now
    // configured — in which case the search targeted an empty per-dimension column
    // and silently found nothing. Distinguish them so the latter surfaces as an
    // actionable error instead of a puzzling empty result.
    if (merged.length === 0) {
      const populated =
        await KbChunkModel.getPopulatedEmbeddingDimensions(connectorIds);
      const mismatch = findEmbeddingDimensionMismatch(
        populated,
        embeddingConfig.dimensions,
      );
      if (mismatch) {
        throw new EmbeddingDimensionMismatchError(
          embeddingConfig.model,
          embeddingConfig.dimensions,
          mismatch,
        );
      }
    }

    let topResults = merged.slice(0, overFetchLimit);

    const preRerankCount = topResults.length;
    topResults = await rerank({
      queryText,
      chunks: topResults,
      organizationId,
      connectorId,
    });
    topResults = topResults.slice(0, limit);

    // Widen each surviving hit with its neighbouring chunks. Deliberately after
    // the rerank and the slice: expansion must not change what ranks or how
    // many results come back, and expanding chunks the rerank was about to drop
    // would be wasted queries.
    //
    // Strictly an enhancement, so it degrades rather than fails: a user asking a
    // question is far better served by the ranked chunks than by an error
    // because the widening query failed.
    try {
      topResults = await expandChunkContext({
        results: topResults,
        radius: config.kb.contextExpansionRadius,
        userAcl: params.userAcl,
        bypassAcl,
        environmentId,
      });
    } catch (error) {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "[QueryService] Context expansion failed, returning unexpanded results",
      );
    }

    logger.info(
      {
        preRerankCount,
        postRerankCount: topResults.length,
        expandedQueryCount: expandedQueries.length,
        contextExpansionRadius: config.kb.contextExpansionRadius,
        resultIds: topResults.map((r) => r.id),
      },
      "[QueryService] Final results (after rerank)",
    );
    // Titles and content previews are indexed corpus content — debug only.
    logger.debug(
      {
        results: topResults.map((r) => ({
          id: r.id,
          score: r.score,
          title: r.title,
          contentPreview: r.content.slice(0, 80),
        })),
      },
      "[QueryService] Final result previews (after rerank)",
    );

    const searchType = hybridEnabled ? "hybrid" : "vector";
    metrics.rag.reportQuery({
      searchType,
      durationSeconds: (Date.now() - queryStartTime) / 1000,
      resultCount: topResults.length,
    });

    return this.mapResults(topResults);
  }

  private async searchSingleQuery(params: {
    queryText: string;
    embeddingConfig: EmbeddingConfig;
    connectorIds: string[];
    /** The one connector this query is scoped to, or null when it spans several. */
    connectorId: string | null;
    limit: number;
    userAcl: AclEntry[];
    bypassAcl: boolean;
    environmentId?: string | null;
    type: "semantic" | "keyword";
    hybridEnabled: boolean;
    searchLanguages: TextSearchLanguage[];
  }): Promise<SingleQuerySearchResult> {
    const {
      queryText,
      embeddingConfig,
      connectorIds,
      connectorId,
      limit,
      userAcl,
      bypassAcl,
      environmentId,
      type,
      hybridEnabled,
      searchLanguages,
    } = params;

    // queryText is user content — payloads only at debug.
    logger.debug(
      { queryText, type, hybridEnabled },
      "[QueryService] Searching expanded query",
    );

    let embeddingResponse: Awaited<ReturnType<typeof callEmbedding>>;
    try {
      embeddingResponse = await withKbObservability({
        operationName: "embedding",
        provider: embeddingConfig.provider,
        model: embeddingConfig.model,
        source: "knowledge:embedding",
        connectorId,
        type: getEmbeddingDiscriminator(embeddingConfig.provider),
        callback: () =>
          callEmbedding({
            inputs: [
              addNomicTaskPrefix(
                embeddingConfig.model,
                queryText,
                "search_query",
              ),
            ],
            model: embeddingConfig.model,
            apiKey: embeddingConfig.apiKey,
            baseUrl: embeddingConfig.baseUrl,
            dimensions: embeddingConfig.dimensions,
            provider: embeddingConfig.provider,
            purpose: "search_query",
          }),
        buildInteraction: (
          response: Parameters<typeof buildEmbeddingInteraction>[0]["response"],
        ) =>
          buildEmbeddingInteraction({
            model: embeddingConfig.model,
            input: queryText,
            dimensions: embeddingConfig.dimensions,
            response,
          }),
      });
    } catch (error) {
      // Map the raw provider/network failure into a typed KB error naming the
      // provider/model, so the query handler can present an actionable message.
      throw normalizeEmbeddingError(error, {
        provider: embeddingConfig.provider,
        model: embeddingConfig.model,
      });
    }

    if (!embeddingResponse.data[0]?.embedding) {
      logger.warn(
        { queryLength: queryText.length },
        "[QueryService] Embedding API returned no embedding for query",
      );
      return { rows: [], lanesAttempted: 0, lanesTimedOut: 0 };
    }
    const queryEmbedding = embeddingResponse.data[0].embedding;

    // Each lane is cut individually by the search statement timeout (`null` =
    // timed out): dropping one lane degrades the merge instead of failing the
    // whole query, and the caller escalates only when every lane is gone.
    const [vectorRows, fullTextRows] = await Promise.all([
      runSearchLane("vector", () =>
        KbChunkModel.vectorSearch({
          connectorIds,
          queryEmbedding,
          dimensions: embeddingConfig.dimensions,
          limit,
          userAcl,
          bypassAcl,
          environmentId,
        }),
      ),
      hybridEnabled
        ? runSearchLane("keyword", () =>
            KbChunkModel.fullTextSearch({
              connectorIds,
              queryText,
              languages: searchLanguages,
              limit,
              userAcl,
              bypassAcl,
              environmentId,
            }),
          )
        : Promise.resolve<VectorSearchResult[] | null>([]),
    ]);

    const lanesAttempted = hybridEnabled ? 2 : 1;
    const lanesTimedOut =
      (vectorRows === null ? 1 : 0) +
      (hybridEnabled && fullTextRows === null ? 1 : 0);

    logger.info(
      {
        type,
        vectorCount: vectorRows?.length ?? "timed_out",
        fullTextCount: fullTextRows?.length ?? "timed_out",
      },
      "[QueryService] Expanded query search results",
    );

    if (!hybridEnabled) {
      return { rows: vectorRows ?? [], lanesAttempted, lanesTimedOut };
    }

    // Inner RRF: for keyword queries, favor BM25 (full-text)
    const innerWeights =
      type === "keyword" ? [1.0, KEYWORD_QUERY_HYBRID_ALPHA_WEIGHT] : undefined;

    const fused = reciprocalRankFusion<VectorSearchResult>({
      rankings: [vectorRows ?? [], fullTextRows ?? []],
      idExtractor: (row) => row.id,
      k: 60,
      weights: innerWeights,
    });

    return { rows: fused.slice(0, limit), lanesAttempted, lanesTimedOut };
  }

  private mapResults(rows: VectorSearchResult[]): ChunkResult[] {
    return rows.map((row) => ({
      content: row.content,
      score: row.score,
      chunkIndex: row.chunkIndex,
      metadata: row.metadata,
      ref: buildChunkRef(row.documentId, row.chunkIndex),
      citation: {
        title: row.title,
        sourceUrl: row.sourceUrl,
        documentId: row.documentId,
        sourceId: row.sourceId ?? null,
        connectorType: row.connectorType,
      },
    }));
  }
}

export const queryService = new QueryService();

interface SingleQuerySearchResult {
  rows: VectorSearchResult[];
  /** Search statements actually issued: vector always, keyword when hybrid. */
  lanesAttempted: number;
  /** Of those, how many the database statement timeout cut. */
  lanesTimedOut: number;
}

/**
 * Run one search lane, absorbing a statement-timeout cancellation into `null`
 * (logged + metered) so the caller can merge the surviving lanes. Every other
 * failure still throws — only the timeout is a planned degradation.
 */
async function runSearchLane(
  lane: "vector" | "keyword",
  run: () => Promise<VectorSearchResult[]>,
): Promise<VectorSearchResult[] | null> {
  try {
    return await run();
  } catch (error) {
    if (!isDbStatementTimeoutError(error)) throw error;
    metrics.rag.reportSearchLaneTimeout(lane);
    logger.warn(
      { lane },
      "[QueryService] Search lane hit the statement timeout; dropping it and merging the remaining lanes",
    );
    return null;
  }
}

/**
 * Decide whether an empty search result reflects a dimension mismatch rather than
 * a genuine no-match. Returns the ingested dimensions when NONE match the
 * configured one, or `null` when there is no conflict — either because no
 * documents are ingested (a legitimate empty result) or because documents exist
 * at the configured dimension (also a legitimate no-match).
 *
 * This runs only when the search returned nothing, so it catches the whole-corpus
 * mismatch (everything ingested at another dimension). A mixed corpus where some
 * connectors match the configured dimension and others don't is NOT fully covered
 * — those results suppress this check — but that requires connectors ingested at
 * different dimensions, which the embedding-config lock normally prevents.
 *
 * @public — pure decision helper extracted for unit testing (pgvector column
 * behavior is not exercisable in the PGlite test DB); called within this module.
 */
export function findEmbeddingDimensionMismatch(
  populatedDimensions: Set<number>,
  configuredDimension: number,
): number[] | null {
  if (populatedDimensions.size === 0) return null;
  if (populatedDimensions.has(configuredDimension)) return null;
  return [...populatedDimensions];
}
