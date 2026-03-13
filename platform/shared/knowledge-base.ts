import { z } from "zod";

/**
 * Supported embedding models for knowledge base RAG.
 * Accepts any model name string — the EMBEDDING_MODELS record provides suggestions.
 */
export const EmbeddingModelSchema = z.string().min(1);
export type EmbeddingModel = string;

export const DEFAULT_EMBEDDING_MODEL: EmbeddingModel = "text-embedding-3-small";

/** Maximum number of chunks to embed per OpenAI API call */
export const EMBEDDING_BATCH_SIZE = 100;

/** Default vector dimensions (used for the primary `embedding` column) */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Providers whose API keys can be used for embedding.
 * These providers expose an OpenAI-compatible `/v1/embeddings` endpoint.
 */
export const EMBEDDING_COMPATIBLE_PROVIDERS = new Set(["openai", "ollama"]);

/**
 * Supported embedding column sizes. Each entry maps to a dedicated
 * `vector(N)` column and HNSW index in the `kb_chunks` table.
 */
export const SUPPORTED_EMBEDDING_DIMENSIONS = [1536, 768] as const;
export type SupportedEmbeddingDimension =
  (typeof SUPPORTED_EMBEDDING_DIMENSIONS)[number];

/**
 * Maps a dimension size to its database column name.
 * - 1536 → "embedding" (original column, kept for backward compatibility)
 * - 768  → "embedding_768"
 */
export function getEmbeddingColumnName(dimensions: number): string {
  if (dimensions === 1536) return "embedding";
  return `embedding_${dimensions}`;
}

interface EmbeddingModelMeta {
  label: string;
  description: string;
  dimensions: SupportedEmbeddingDimension;
}

/**
 * Embedding model metadata used by both frontend (settings UI) and backend (embedding dimensions).
 * For text-embedding-3-large, dimensions are reduced to 1536 to match the pgvector index.
 * Known models — users can also type any custom model name.
 */
export const EMBEDDING_MODELS: Record<string, EmbeddingModelMeta> = {
  "text-embedding-3-small": {
    label: "text-embedding-3-small",
    description: "Best cost/quality ratio (1536 dims)",
    dimensions: 1536,
  },
  "text-embedding-3-large": {
    label: "text-embedding-3-large",
    description: "Higher quality, 3072 dims, reduced to 1536 dims",
    dimensions: 1536,
  },
  "nomic-embed-text": {
    label: "nomic-embed-text",
    description: "Open-source model, 768 dims (Ollama compatible)",
    dimensions: 768,
  },
};

/**
 * Display labels for connector types.
 * Used in UI placeholders and titles.
 */
export const CONNECTOR_TYPE_LABELS: Record<string, string> = {
  jira: "Jira",
  confluence: "Confluence",
  github: "GitHub",
  gitlab: "GitLab",
};

const CONNECTOR_PLACEHOLDER_DEPARTMENTS = [
  "Engineering",
  "Finance",
  "Marketing",
  "Sales",
  "Product",
  "Design",
  "Operations",
  "Support",
];

/**
 * Generate a placeholder connector name like "Marketing Confluence Connector".
 * Picks a random department each call.
 */
export function getConnectorNamePlaceholder(connectorType: string): string {
  const department =
    CONNECTOR_PLACEHOLDER_DEPARTMENTS[
      Math.floor(Math.random() * CONNECTOR_PLACEHOLDER_DEPARTMENTS.length)
    ];
  const label = CONNECTOR_TYPE_LABELS[connectorType] ?? connectorType;
  return `${department} ${label} Connector`;
}

/** Default LLM model used for reranking knowledge base search results */
export const DEFAULT_RERANKER_MODEL = "gpt-4o";

/** Minimum relevance score (0-10) for reranked chunks to be included in results */
export const RERANKER_MIN_RELEVANCE_SCORE = 3;

/**
 * Nomic embedding models require task instruction prefixes in the input text.
 * Documents should use "search_document: " and queries should use "search_query: ".
 * See: https://huggingface.co/nomic-ai/nomic-embed-text-v1.5
 */
type NomicTaskType = "search_document" | "search_query";

function isNomicModel(model: string): boolean {
  return model.startsWith("nomic");
}

/**
 * Add the appropriate Nomic task prefix to embedding input text.
 * For non-Nomic models, returns the text unchanged.
 */
export function addNomicTaskPrefix(
  model: string,
  text: string,
  taskType: NomicTaskType,
): string {
  if (!isNomicModel(model)) return text;
  return `${taskType}: ${text}`;
}

/**
 * Get the embedding dimensions for a given model.
 * Falls back to EMBEDDING_DIMENSIONS for unknown models.
 */
export function getEmbeddingDimensions(model: string): number {
  return EMBEDDING_MODELS[model]?.dimensions ?? EMBEDDING_DIMENSIONS;
}
