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
