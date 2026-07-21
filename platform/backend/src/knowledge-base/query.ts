import { addNomicTaskPrefix } from "@archestra/shared";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { callEmbedding, getEmbeddingDiscriminator } from "./embedding-clients";
import {
  EmbeddingDimensionMismatchError,
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
import rerank from "./reranker";
import reciprocalRankFusion from "./rrf";

interface ChunkResult {
  content: string;
  score: number;
  chunkIndex: number;
  metadata: Record<string, unknown> | null;
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

    const expandedQueries = await expandQuery({ queryText, organizationId });

    const perQueryResults = await Promise.all(
      expandedQueries.map((eq) =>
        this.searchSingleQuery({
          queryText: eq.queryText,
          embeddingConfig,
          connectorIds,
          limit: overFetchLimit,
          userAcl: params.userAcl,
          bypassAcl,
          environmentId,
          type: eq.type,
          hybridEnabled,
        }),
      ),
    );

    const weights = expandedQueries.map((eq) => eq.weight);

    const merged = reciprocalRankFusion<VectorSearchResult>({
      rankings: perQueryResults,
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
    });
    topResults = topResults.slice(0, limit);

    logger.info(
      {
        preRerankCount,
        postRerankCount: topResults.length,
        expandedQueryCount: expandedQueries.length,
        results: topResults.map((r) => ({
          id: r.id,
          score: r.score,
          title: r.title,
          contentPreview: r.content.slice(0, 80),
        })),
      },
      "[QueryService] Final results (after rerank)",
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
    limit: number;
    userAcl: AclEntry[];
    bypassAcl: boolean;
    environmentId?: string | null;
    type: "semantic" | "keyword";
    hybridEnabled: boolean;
  }): Promise<VectorSearchResult[]> {
    const {
      queryText,
      embeddingConfig,
      connectorIds,
      limit,
      userAcl,
      bypassAcl,
      environmentId,
      type,
      hybridEnabled,
    } = params;

    logger.info(
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
        { queryText },
        "[QueryService] Embedding API returned no embedding for query",
      );
      return [];
    }
    const queryEmbedding = embeddingResponse.data[0].embedding;

    const fullTextPromise = hybridEnabled
      ? KbChunkModel.fullTextSearch({
          connectorIds,
          queryText,
          limit,
          userAcl,
          bypassAcl,
          environmentId,
        })
      : Promise.resolve([] as VectorSearchResult[]);

    const [vectorRows, fullTextRows] = await Promise.all([
      KbChunkModel.vectorSearch({
        connectorIds,
        queryEmbedding,
        dimensions: embeddingConfig.dimensions,
        limit,
        userAcl,
        bypassAcl,
        environmentId,
      }),
      fullTextPromise,
    ]);

    logger.info(
      {
        queryText,
        type,
        vectorCount: vectorRows.length,
        fullTextCount: fullTextRows.length,
      },
      "[QueryService] Expanded query search results",
    );

    if (!hybridEnabled) {
      return vectorRows;
    }

    // Inner RRF: for keyword queries, favor BM25 (full-text)
    const innerWeights =
      type === "keyword" ? [1.0, KEYWORD_QUERY_HYBRID_ALPHA_WEIGHT] : undefined;

    const fused = reciprocalRankFusion<VectorSearchResult>({
      rankings: [vectorRows, fullTextRows],
      idExtractor: (row) => row.id,
      k: 60,
      weights: innerWeights,
    });

    return fused.slice(0, limit);
  }

  private mapResults(rows: VectorSearchResult[]): ChunkResult[] {
    return rows.map((row) => ({
      content: row.content,
      score: row.score,
      chunkIndex: row.chunkIndex,
      metadata: row.metadata,
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
