import { z } from "zod";

/**
 * Supported embedding models for knowledge base RAG.
 * Only OpenAI embedding models are supported currently.
 */
export const EmbeddingModelSchema = z.enum([
  "text-embedding-3-small",
  "text-embedding-3-large",
]);
export type EmbeddingModel = z.infer<typeof EmbeddingModelSchema>;

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = "text-embedding-3-small";

/** Maximum number of chunks to embed per OpenAI API call */
export const EMBEDDING_BATCH_SIZE = 100;

/** Vector dimensions used for pgvector index and embedding API calls */
export const EMBEDDING_DIMENSIONS = 1536;

interface EmbeddingModelMeta {
  label: string;
  description: string;
  dimensions: number;
}

/**
 * Embedding model metadata used by both frontend (settings UI) and backend (embedding dimensions).
 * For text-embedding-3-large, dimensions are reduced to 1536 to match the pgvector index.
 *
 * Typed as `Record<EmbeddingModel, …>` so adding a new enum value without an entry here
 * causes a compile error.
 */
export const EMBEDDING_MODELS: Record<EmbeddingModel, EmbeddingModelMeta> = {
  "text-embedding-3-small": {
    // https://developers.openai.com/api/docs/guides/embeddings/#embedding-models
    label: "text-embedding-3-small",
    description: "Best cost/quality ratio (1536 dims)",
    dimensions: EMBEDDING_DIMENSIONS,
  },
  "text-embedding-3-large": {
    // https://developers.openai.com/api/docs/guides/embeddings/#embedding-models
    label: "text-embedding-3-large",
    description: "Higher quality, 3072 dims, reduced to 1536 dims",
    dimensions: EMBEDDING_DIMENSIONS,
  },
};

/** Default LLM model used for reranking knowledge base search results */
export const DEFAULT_RERANKER_MODEL = "gpt-4o";

/** Minimum relevance score (0-10) for reranked chunks to be included in results */
export const RERANKER_MIN_RELEVANCE_SCORE = 3;

/**
 * Get the embedding dimensions for a given model.
 */
export function getEmbeddingDimensions(model: EmbeddingModel): number {
  return EMBEDDING_MODELS[model].dimensions;
}
