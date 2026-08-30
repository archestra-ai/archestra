import type { SupportedProvider } from "@archestra/shared";
import {
  RERANKER_MIN_RELEVANCE_SCORE,
  RERANKER_NATIVE_MIN_RELEVANCE_SCORE,
} from "@archestra/shared";
import { generateObject } from "ai";
import { z } from "zod";
import logger from "@/logging";
import type { VectorSearchResult } from "@/models/kb-chunk";
import { repairStructuredOutputText } from "@/utils/structured-output-repair";
import {
  getProviderChatInteractionType,
  withKbObservability,
} from "./kb-interaction";
import { type RerankerConfig, resolveRerankerConfig } from "./kb-llm-client";
import { callNativeRerank } from "./native-rerank";
import { RERANKER_OUTPUT_CONTRACT } from "./reranker-prompt";

/** Diagnostic outcome for in-platform evaluation; ordinary callers omit it. */
export interface RerankDiagnostics {
  status: "disabled" | "unavailable" | "succeeded" | "failed";
  kind: "llm" | "native-rerank" | null;
  provider: SupportedProvider | null;
  model: string | null;
  changedOrder: boolean;
  filteredCount: number;
  error: string | null;
}

async function rerank(params: {
  queryText: string;
  chunks: VectorSearchResult[];
  organizationId: string;
  /** The one connector this query is scoped to, or null when it spans several. */
  connectorId?: string | null;
  /** Observe the real reranker path without changing its best-effort behavior. */
  onDiagnostics?: (diagnostics: RerankDiagnostics) => void;
  config?: RerankerConfig;
}): Promise<VectorSearchResult[]> {
  const {
    queryText,
    chunks,
    organizationId,
    connectorId = null,
    onDiagnostics,
  } = params;

  if (chunks.length === 0) {
    return [];
  }

  let rerankerConfig: Awaited<ReturnType<typeof resolveRerankerConfig>>;
  try {
    rerankerConfig =
      params.config ?? (await resolveRerankerConfig(organizationId));
  } catch (error) {
    // Reranking is optional and best-effort: an unresolvable reranker config
    // must not fail the whole query. Return the original order; the fault is
    // surfaced at save time (and blocks saving an invalid reranker).
    logger.warn(
      {
        organizationId,
        error: error instanceof Error ? error.message : String(error),
      },
      "[Reranker] Reranker config unresolvable, returning original order",
    );
    emitDiagnostics(onDiagnostics, {
      status: "unavailable",
      kind: null,
      provider: null,
      model: null,
      changedOrder: false,
      filteredCount: 0,
      error: summarize(error),
    });
    return chunks;
  }
  if (!rerankerConfig) {
    logger.warn(
      { organizationId },
      "[Reranker] No reranker API key configured, skipping reranking",
    );
    emitDiagnostics(onDiagnostics, {
      status: "disabled",
      kind: null,
      provider: null,
      model: null,
      changedOrder: false,
      filteredCount: 0,
      error: null,
    });
    return chunks;
  }

  if (rerankerConfig.kind === "native-rerank") {
    return nativeRerank({
      queryText,
      chunks,
      config: rerankerConfig,
      onDiagnostics,
    });
  }

  const numberedList = chunks
    .map((chunk, i) => `[${i}] ${chunk.content}`)
    .join("\n\n");

  const prompt = `You are a relevance scoring assistant. Given a search query and a list of text passages, score each passage on how relevant it is to the query.

Query: ${queryText}

Passages:
${numberedList}

Score each passage from 0 (completely irrelevant) to 10 (perfectly relevant). Return scores for all passages.

${RERANKER_OUTPUT_CONTRACT}`;

  const schema = z.object({
    scores: z.array(
      z.object({
        index: z.number(),
        score: z.number().describe("Relevance score from 0 to 10"),
      }),
    ),
  });

  logger.info(
    {
      provider: rerankerConfig.provider,
      model: rerankerConfig.modelName,
      chunkCount: chunks.length,
    },
    "[Reranker] Calling LLM for reranking",
  );

  try {
    const result = await withKbObservability({
      operationName: "chat",
      provider: rerankerConfig.provider,
      model: rerankerConfig.modelName,
      source: "knowledge:reranker",
      connectorId,
      type: getProviderChatInteractionType(rerankerConfig.provider),
      callback: () =>
        generateObject({
          model: rerankerConfig.llmModel,
          schema,
          prompt,
          experimental_repairText: repairStructuredOutputText,
        }),
      buildInteraction: (res) =>
        buildRerankerInteraction(rerankerConfig, prompt, res),
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
        chunkCount: chunks.length,
        filteredOut: reranked.length - filtered.length,
        minRelevanceScore: RERANKER_MIN_RELEVANCE_SCORE,
        scores: reranked.map(({ score }) => score),
      },
      "[Reranker] LLM scores received",
    );
    // Query text, titles, and previews are user/corpus content — debug only.
    logger.debug(
      {
        queryText,
        scoredChunks: reranked.map(({ chunk, score }) => ({
          score,
          kept: score >= RERANKER_MIN_RELEVANCE_SCORE,
          title: chunk.title,
          contentPreview: chunk.content.slice(0, 80),
        })),
      },
      "[Reranker] LLM score previews",
    );

    const rerankedChunks = filtered.map((r) => r.chunk);
    emitDiagnostics(onDiagnostics, {
      status: "succeeded",
      kind: "llm",
      provider: rerankerConfig.provider,
      model: rerankerConfig.modelName,
      changedOrder: orderChanged(chunks, rerankedChunks),
      filteredCount: chunks.length - rerankedChunks.length,
      error: null,
    });
    return rerankedChunks;
  } catch (error) {
    logger.warn(
      { error },
      "[Reranker] LLM reranking failed, returning original order",
    );
    emitDiagnostics(onDiagnostics, {
      status: "failed",
      kind: "llm",
      provider: rerankerConfig.provider,
      model: rerankerConfig.modelName,
      changedOrder: false,
      filteredCount: 0,
      error: summarize(error),
    });
    return chunks;
  }
}

export default rerank;

// ===== Internal helpers =====

/**
 * Rerank through the provider's native rerank API (Cohere Rerank, directly or
 * Azure-hosted). Same contract as the LLM path: sort by relevance, drop chunks
 * below the (native-scale) floor, and fall back to the original order on any
 * failure — reranking stays best-effort.
 */
async function nativeRerank(params: {
  queryText: string;
  chunks: VectorSearchResult[];
  config: {
    provider: SupportedProvider;
    modelName: string;
    apiKey: string | null;
    baseUrl: string | null;
  };
  onDiagnostics?: (diagnostics: RerankDiagnostics) => void;
}): Promise<VectorSearchResult[]> {
  const { queryText, chunks, config, onDiagnostics } = params;

  logger.info(
    {
      provider: config.provider,
      model: config.modelName,
      chunkCount: chunks.length,
    },
    "[Reranker] Calling native rerank API",
  );

  try {
    const scores = await callNativeRerank({
      provider: config.provider,
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.modelName,
      query: queryText,
      documents: chunks.map((chunk) => chunk.content),
    });

    const scoreMap = new Map<number, number>();
    for (const { index, score } of scores) {
      scoreMap.set(index, score);
    }

    const reranked = chunks
      .map((chunk, idx) => ({ chunk, score: scoreMap.get(idx) ?? 0 }))
      .sort((a, b) => b.score - a.score);

    const filtered = reranked.filter(
      (r) => r.score >= RERANKER_NATIVE_MIN_RELEVANCE_SCORE,
    );

    logger.info(
      {
        chunkCount: chunks.length,
        filteredOut: reranked.length - filtered.length,
        minRelevanceScore: RERANKER_NATIVE_MIN_RELEVANCE_SCORE,
        scores: reranked.map(({ score }) => score),
      },
      "[Reranker] Native rerank scores received",
    );

    const result = filtered.map((r) => r.chunk);
    emitDiagnostics(onDiagnostics, {
      status: "succeeded",
      kind: "native-rerank",
      provider: config.provider,
      model: config.modelName,
      changedOrder: orderChanged(chunks, result),
      filteredCount: chunks.length - result.length,
      error: null,
    });
    return result;
  } catch (error) {
    logger.warn(
      { error },
      "[Reranker] Native reranking failed, returning original order",
    );
    emitDiagnostics(onDiagnostics, {
      status: "failed",
      kind: "native-rerank",
      provider: config.provider,
      model: config.modelName,
      changedOrder: false,
      filteredCount: 0,
      error: summarize(error),
    });
    return chunks;
  }
}

function emitDiagnostics(
  callback: ((diagnostics: RerankDiagnostics) => void) | undefined,
  diagnostics: RerankDiagnostics,
): void {
  callback?.(diagnostics);
}

function orderChanged(
  before: VectorSearchResult[],
  after: VectorSearchResult[],
): boolean {
  return (
    before.length !== after.length ||
    before.some((chunk, index) => chunk.id !== after[index]?.id)
  );
}

function summarize(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRerankerInteraction(
  config: { modelName: string; provider: SupportedProvider },
  prompt: string,
  // biome-ignore lint/suspicious/noExplicitAny: Vercel AI SDK result type is complex
  result: any,
) {
  const usage = result.usage as
    | { promptTokens?: number; completionTokens?: number }
    | undefined;

  return {
    request: {
      model: config.modelName,
      messages: [{ role: "user" as const, content: prompt }],
    },
    response: {
      id: `reranker-${crypto.randomUUID()}`,
      object: "chat.completion" as const,
      created: Math.floor(Date.now() / 1000),
      model: config.modelName,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant" as const,
            content: JSON.stringify(result.object),
            refusal: null,
          },
          finish_reason: "stop" as const,
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: usage?.promptTokens ?? 0,
        completion_tokens: usage?.completionTokens ?? 0,
        total_tokens:
          (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
      },
    },
    model: config.modelName,
    inputTokens: usage?.promptTokens ?? 0,
    outputTokens: usage?.completionTokens ?? 0,
  };
}
