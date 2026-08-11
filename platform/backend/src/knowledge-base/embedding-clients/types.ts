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
 * Image inputs are only supported by multimodal embedding models (e.g. gemini-embedding-2).
 */
export type EmbeddingInput = string | { mimeType: string; data: string };

/**
 * What the embedding is for. Some models condition the vector on this —
 * Cohere on Bedrock takes it as `input_type` and expects documents embedded
 * as `search_document` and queries as `search_query`; mixing the two silently
 * degrades ranking. Clients with no such parameter ignore it. Defaults to
 * `search_document` (the ingestion path) when omitted.
 */
export type EmbeddingPurpose = "search_document" | "search_query";
