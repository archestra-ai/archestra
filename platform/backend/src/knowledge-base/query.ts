import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";
import type { VectorSearchResult } from "@/models/kb-chunk";
import type { AclEntry } from "@/types/kb-document";
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
  private openai: OpenAI | null = null;

  async query(params: {
    connectorIds: string[];
    queryText: string;
    userAcl: AclEntry[];
    limit?: number;
  }): Promise<ChunkResult[]> {
    const { connectorIds, queryText, limit = 10 } = params;
    if (connectorIds.length === 0) return [];

    const hybridEnabled = config.kb.hybridSearchEnabled;
    const overFetchLimit = hybridEnabled ? limit * 2 : limit;

    const embeddingPromise = this.getOpenAIClient().embeddings.create({
      model: "text-embedding-3-small",
      input: queryText,
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
        rerankerEnabled: config.kb.rerankerEnabled,
      },
      "[QueryService] Search candidates retrieved",
    );

    let topResults: VectorSearchResult[];
    if (hybridEnabled) {
      const fused = reciprocalRankFusion<VectorSearchResult>({
        rankings: [vectorRows, fullTextRows],
        idExtractor: (row) => row.id,
      });
      topResults = fused.slice(
        0,
        config.kb.rerankerEnabled ? overFetchLimit : limit,
      );
    } else {
      topResults = vectorRows;
    }

    if (config.kb.rerankerEnabled) {
      topResults = await rerank({
        queryText,
        chunks: topResults,
        openaiApiKey: config.kb.embeddingApiKey,
      });
      topResults = topResults.slice(0, limit);
    }

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

  private getOpenAIClient(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({ apiKey: config.kb.embeddingApiKey });
    }
    return this.openai;
  }
}

export const queryService = new QueryService();
