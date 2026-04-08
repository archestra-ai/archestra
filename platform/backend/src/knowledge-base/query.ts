import { addNomicTaskPrefix } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import { callEmbedding, getEmbeddingDiscriminator } from "./embedding-clients";
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
    limit?: number;
  }): Promise<ChunkResult[]> {
    const {
      connectorIds,
      organizationId,
      queryText,
      bypassAcl = false,
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
      type,
      hybridEnabled,
    } = params;

    logger.info(
      { queryText, type, hybridEnabled },
      "[QueryService] Searching expanded query",
    );

    const embeddingResponse = await withKbObservability({
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
        connectorType: row.connectorType,
      },
    }));
  }
}

export const queryService = new QueryService();
