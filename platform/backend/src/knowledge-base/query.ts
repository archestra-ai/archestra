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
    knowledgeBaseId: string;
    queryText: string;
    userAcl: AclEntry[];
    limit?: number;
  }): Promise<ChunkResult[]> {
    const { knowledgeBaseId, queryText, limit = 10 } = params;
    const hybridEnabled = config.kb.hybridSearchEnabled;
    const overFetchLimit = hybridEnabled ? limit * 2 : limit;

    const embeddingPromise = this.getOpenAIClient().embeddings.create({
      model: "text-embedding-3-small",
      input: queryText,
    });

    const fullTextPromise = hybridEnabled
      ? KbChunkModel.fullTextSearch({
          knowledgeBaseId,
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
      knowledgeBaseId,
      queryEmbedding,
      limit: overFetchLimit,
    });

    logger.info(
      {
        knowledgeBaseId,
        queryText,
        vectorCount: vectorRows.length,
        fullTextCount: fullTextRows.length,
        hybridEnabled,
        rerankerEnabled: config.kb.rerankerEnabled,
        vectorTopScores: vectorRows
          .slice(0, 5)
          .map((r) => ({ id: r.id, score: r.score, title: r.title })),
        fullTextTopScores: fullTextRows
          .slice(0, 5)
          .map((r) => ({ id: r.id, score: r.score, title: r.title })),
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

      logger.info(
        {
          knowledgeBaseId,
          fusedCount: topResults.length,
          fusedTop: topResults
            .slice(0, 5)
            .map((r) => ({ id: r.id, score: r.score, title: r.title })),
        },
        "[QueryService] RRF fusion completed",
      );
    } else {
      topResults = vectorRows;
    }

    if (config.kb.rerankerEnabled) {
      const beforeRerank = topResults.map((r) => r.id);
      topResults = await rerank({
        queryText,
        chunks: topResults,
        openaiApiKey: config.kb.embeddingApiKey,
      });
      topResults = topResults.slice(0, limit);

      logger.info(
        {
          knowledgeBaseId,
          beforeRerank,
          afterRerank: topResults.map((r) => ({
            id: r.id,
            title: r.title,
          })),
        },
        "[QueryService] Reranker completed",
      );
    }

    logger.info(
      {
        knowledgeBaseId,
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

    return topResults.map((row) => ({
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
