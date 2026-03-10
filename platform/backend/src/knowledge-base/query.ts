import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import type { AclEntry } from "@/types/kb-document";
import {
  buildEmbeddingInteraction,
  withKbObservability,
} from "./kb-interaction";
import { resolveEmbeddingConfig } from "./kb-llm-client";
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

    const embeddingPromise = withKbObservability({
      operationName: "embedding",
      provider: "openai",
      model: embeddingConfig.model,
      source: "knowledge:embedding",
      type: "openai:embeddings",
      callback: () =>
        embeddingConfig.client.embeddings.create({
          model: embeddingConfig.model,
          input: queryText,
          dimensions: embeddingConfig.dimensions,
        }),
      buildInteraction: (response) =>
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

    const vectorRows = await KbChunkModel.vectorSearch({
      connectorIds,
      queryEmbedding,
      limit: overFetchLimit,
    });

    logger.info(
      {
        connectorIds,
        queryText,
        vectorCount: vectorRows.length,
        fullTextCount: fullTextRows.length,
        hybridEnabled,
      },
      "[QueryService] Search candidates retrieved",
    );

    let topResults: VectorSearchResult[];
    if (hybridEnabled) {
      const fused = reciprocalRankFusion<VectorSearchResult>({
        rankings: [vectorRows, fullTextRows],
        idExtractor: (row) => row.id,
      });
      topResults = fused.slice(0, overFetchLimit);
    } else {
      topResults = vectorRows;
    }

    topResults = await rerank({
      queryText,
      chunks: topResults,
      organizationId,
    });
    topResults = topResults.slice(0, limit);

    logger.info(
      {
        resultCount: topResults.length,
        results: topResults.map((r) => ({
          id: r.id,
          score: r.score,
          title: r.title,
          contentPreview: r.content.slice(0, 80),
        })),
      },
      "[QueryService] Final results",
    );

    return this.mapResults(topResults);
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
