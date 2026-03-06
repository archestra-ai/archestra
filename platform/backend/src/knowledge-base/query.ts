import OpenAI from "openai";
import config from "@/config";
import logger from "@/logging";
import { KbChunkModel } from "@/models";

interface ChunkResult {
  content: string;
  score: number;
  chunkIndex: number;
  citation: {
    title: string;
    sourceUrl: string | null;
    sourceType: string;
    documentId: string;
  };
}

class QueryService {
  private openai: OpenAI | null = null;

  async query(params: {
    knowledgeBaseId: string;
    queryText: string;
    userAcl: string[];
    limit?: number;
  }): Promise<ChunkResult[]> {
    const { knowledgeBaseId, queryText, limit = 10 } = params;

    const client = this.getOpenAIClient();
    const response = await client.embeddings.create({
      model: "text-embedding-3-small",
      input: queryText,
    });

    const queryEmbedding = response.data[0].embedding;

    const rows = await KbChunkModel.vectorSearch({
      knowledgeBaseId,
      queryEmbedding,
      limit,
    });

    logger.info(
      { knowledgeBaseId, resultCount: rows.length },
      "[QueryService] Vector search completed",
    );

    return rows.map((row) => ({
      content: row.content,
      score: row.score,
      chunkIndex: row.chunkIndex,
      citation: {
        title: row.title,
        sourceUrl: row.sourceUrl,
        sourceType: row.sourceType,
        documentId: row.documentId,
      },
    }));
  }

  private getOpenAIClient(): OpenAI {
    if (!this.openai) {
      this.openai = new OpenAI({ apiKey: config.kb.openaiApiKey });
    }
    return this.openai;
  }
}

export const queryService = new QueryService();
