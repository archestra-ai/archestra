import { addNomicTaskPrefix, getEmbeddingColumnName } from "@shared";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import * as metrics from "@/observability/metrics";
import type { AclEntry } from "@/types";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import { resolveEmbeddingConfig } from "./kb-llm-client";
import type { ExpandedQuery } from "./query-expansion";
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
  citation: {
    title: string;
    sourceUrl: string | null;
    documentId: string;
    connectorType: string | null;
  };
}

interface EmbeddingConfig {
  // biome-ignore lint/suspicious/noExplicitAny: OpenAI client type
  client: any;
  model: string;
  dimensions: number;
}

class QueryService {
  async query(params: {
    connectorIds: string[];
    organizationId: string;
    queryText: string;
    userAcl: AclEntry[];
    limit?: number;
  }): Promise<ChunkResult[]> {
    const { connectorIds, organizationId, queryText, limit = 10 } = params;
    if (connectorIds.length === 0) return [];

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

    // Expand query if enabled
    let expandedQueries: ExpandedQuery[];
    if (config.kb.queryExpansionEnabled) {
      expandedQueries = await expandQuery({ queryText, organizationId });
    } else {
      expandedQueries = [{ queryText, weight: 1.0, type: "semantic" }];
    }

    const isMultiQuery = expandedQueries.length > 1;

    if (isMultiQuery) {
      // Multi-query path: search each expanded query independently, then merge via weighted RRF
      const perQueryResults = await Promise.all(
        expandedQueries.map((eq) =>
          this.searchSingleQuery({
            queryText: eq.queryText,
            embeddingConfig,
            connectorIds,
            limit: overFetchLimit,
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
        "[QueryService] Final results (multi-query, after rerank)",
      );

      const searchType = hybridEnabled ? "hybrid" : "vector";
      metrics.rag.reportQuery({
        searchType,
        durationSeconds: (Date.now() - queryStartTime) / 1000,
        resultCount: topResults.length,
      });

      return this.mapResults(topResults);
    }

    // Single-query path (original flow)
    const topResults = await this.executeSingleQueryFlow({
      queryText,
      embeddingConfig,
      connectorIds,
      organizationId,
      limit,
      overFetchLimit,
      hybridEnabled,
      queryStartTime,
    });

    return this.mapResults(topResults);
  }

  private async searchSingleQuery(params: {
    queryText: string;
    embeddingConfig: EmbeddingConfig;
    connectorIds: string[];
    limit: number;
    type: "semantic" | "keyword";
    hybridEnabled: boolean;
  }): Promise<VectorSearchResult[]> {
    const {
      queryText,
      embeddingConfig,
      connectorIds,
      limit,
      type,
      hybridEnabled,
    } = params;

    logger.info(
      { queryText, type, hybridEnabled },
      "[QueryService] Searching expanded query",
    );

    const embeddingResponse = await withKbObservability({
      operationName: "embedding",
      provider: "openai",
      model: embeddingConfig.model,
      source: "knowledge:embedding",
      type: "openai:embeddings",
      callback: () =>
        embeddingConfig.client.embeddings.create({
          model: embeddingConfig.model,
          input: addNomicTaskPrefix(
            embeddingConfig.model,
            queryText,
            "search_query",
          ),
          ...(embeddingConfig.model.startsWith("nomic")
            ? {}
            : { dimensions: embeddingConfig.dimensions }),
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

    const queryEmbedding = embeddingResponse.data[0].embedding;

    const fullTextPromise = hybridEnabled
      ? KbChunkModel.fullTextSearch({
          connectorIds,
          queryText,
          limit,
        })
      : Promise.resolve([] as VectorSearchResult[]);

    const [vectorRows, fullTextRows] = await Promise.all([
      KbChunkModel.vectorSearch({
        connectorIds,
        queryEmbedding,
        dimensions: embeddingConfig.dimensions,
        limit,
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

  private async executeSingleQueryFlow(params: {
    queryText: string;
    embeddingConfig: EmbeddingConfig;
    connectorIds: string[];
    organizationId: string;
    limit: number;
    overFetchLimit: number;
    hybridEnabled: boolean;
    queryStartTime: number;
  }): Promise<VectorSearchResult[]> {
    const {
      queryText,
      embeddingConfig,
      connectorIds,
      organizationId,
      limit,
      overFetchLimit,
      hybridEnabled,
      queryStartTime,
    } = params;

    const embeddingPromise = withKbObservability({
      operationName: "embedding",
      provider: "openai",
      model: embeddingConfig.model,
      source: "knowledge:embedding",
      type: "openai:embeddings",
      callback: () =>
        embeddingConfig.client.embeddings.create({
          model: embeddingConfig.model,
          input: addNomicTaskPrefix(
            embeddingConfig.model,
            queryText,
            "search_query",
          ),
          ...(embeddingConfig.model.startsWith("nomic")
            ? {}
            : { dimensions: embeddingConfig.dimensions }),
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

    const fullTextPromise = hybridEnabled
      ? KbChunkModel.fullTextSearch({
          connectorIds,
          queryText,
          limit: overFetchLimit,
        })
      : Promise.resolve([] as VectorSearchResult[]);

    const [embeddingResponse, fullTextRows] = await Promise.all([
      embeddingPromise,
      fullTextPromise,
    ]);

    const queryEmbedding = embeddingResponse.data[0].embedding;
    const embeddingColumn = getEmbeddingColumnName(embeddingConfig.dimensions);

    logger.info(
      {
        queryText,
        model: embeddingConfig.model,
        dimensions: embeddingConfig.dimensions,
        embeddingColumn,
        hybridEnabled,
      },
      "[QueryService] Starting search",
    );

    const vectorRows = await KbChunkModel.vectorSearch({
      connectorIds,
      queryEmbedding,
      dimensions: embeddingConfig.dimensions,
      limit: overFetchLimit,
    });

    const vectorIds = new Set(vectorRows.map((r) => r.id));
    const fullTextIds = new Set(fullTextRows.map((r) => r.id));

    logger.info(
      {
        vectorCount: vectorRows.length,
        fullTextCount: fullTextRows.length,
        vectorOnlyCount: vectorRows.filter((r) => !fullTextIds.has(r.id))
          .length,
        fullTextOnlyCount: fullTextRows.filter((r) => !vectorIds.has(r.id))
          .length,
        bothCount: vectorRows.filter((r) => fullTextIds.has(r.id)).length,
      },
      "[QueryService] Search candidates retrieved",
    );

    let topResults: VectorSearchResult[];
    if (hybridEnabled) {
      const fused = reciprocalRankFusion<VectorSearchResult>({
        rankings: [vectorRows, fullTextRows],
        idExtractor: (row) => row.id,
        k: 60,
      });
      topResults = fused.slice(0, overFetchLimit);
    } else {
      topResults = vectorRows;
    }

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
        results: topResults.map((r) => ({
          id: r.id,
          score: r.score,
          title: r.title,
          source:
            vectorIds.has(r.id) && fullTextIds.has(r.id)
              ? "vector+fulltext"
              : vectorIds.has(r.id)
                ? "vector"
                : "fulltext",
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

    return topResults;
  }

  private mapResults(rows: VectorSearchResult[]): ChunkResult[] {
    return rows.map((row) => ({
      content: row.content,
      score: row.score,
      chunkIndex: row.chunkIndex,
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
