import { RERANKER_MIN_RELEVANCE_SCORE } from "@shared";
import { generateObject } from "ai";
import { z } from "zod";
import logger from "@/logging";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { resolveRerankerConfig } from "./kb-llm-client";

async function rerank(params: {
  queryText: string;
  chunks: VectorSearchResult[];
  organizationId: string;
}): Promise<VectorSearchResult[]> {
  const { queryText, chunks, organizationId } = params;

  if (chunks.length === 0) {
    return [];
  }

  const rerankerConfig = await resolveRerankerConfig(organizationId);
  if (!rerankerConfig) {
    logger.warn(
      { organizationId },
      "[Reranker] No reranker API key configured, skipping reranking",
    );
    return chunks;
  }

  const numberedList = chunks
    .map((chunk, i) => `[${i}] ${chunk.content}`)
    .join("\n\n");

  const prompt = `You are a relevance scoring assistant. Given a search query and a list of text passages, score each passage on how relevant it is to the query.

Query: ${queryText}

Passages:
${numberedList}

Score each passage from 0 (completely irrelevant) to 10 (perfectly relevant). Return scores for all passages.`;

  try {
    const result = await generateObject({
      model: rerankerConfig.llmModel,
      schema: z.object({
        scores: z.array(
          z.object({
            index: z.number(),
            score: z.number().min(0).max(10),
          }),
        ),
      }),
      prompt,
    });

    const scoreMap = new Map<number, number>();
    for (const { index, score } of result.object.scores) {
      scoreMap.set(index, score);
    }

    const reranked = chunks
      .map((chunk, idx) => ({ chunk, score: scoreMap.get(idx) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const filtered = reranked.filter(
      (r) => r.score >= RERANKER_MIN_RELEVANCE_SCORE,
    );

    logger.info(
      {
        queryText,
        chunkCount: chunks.length,
        filteredOut: reranked.length - filtered.length,
        minRelevanceScore: RERANKER_MIN_RELEVANCE_SCORE,
        scores: reranked.map(({ chunk, score }) => ({
          score,
          kept: score >= RERANKER_MIN_RELEVANCE_SCORE,
          title: chunk.title,
          contentPreview: chunk.content.slice(0, 80),
        })),
      },
      "[Reranker] LLM scores received",
    );

    return filtered.map((r) => r.chunk);
  } catch (error) {
    logger.warn(
      { error },
      "[Reranker] LLM reranking failed, returning original order",
    );
    return chunks;
  }
}

export default rerank;
