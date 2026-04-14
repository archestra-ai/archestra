/**
 * Normalized embedding response — compatible with the OpenAI embeddings response shape
 * and used throughout the embedding pipeline regardless of provider.
 */
export interface EmbeddingApiResponse {
  object: string;
  data: Array<{ object: string; embedding: number[]; index: number }>;
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
}

/**
 * A single embedding input — either a text string or an inline image.
 * Image inputs are only supported by multimodal embedding models (e.g. gemini-embedding-2-preview).
 */
export type EmbeddingInput = string | { mimeType: string; data: string };
