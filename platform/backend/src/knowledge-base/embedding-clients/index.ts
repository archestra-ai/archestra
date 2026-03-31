import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@shared";
import { callGeminiEmbedding, GeminiEmbeddingError } from "./gemini";
import { callOpenAIEmbedding, OpenAIEmbeddingError } from "./openai";
import type { EmbeddingApiResponse } from "./types";

export type { EmbeddingApiResponse };
export { GeminiEmbeddingError, OpenAIEmbeddingError };

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
]);

/**
 * Provider-agnostic embedding call.
 * Dispatches to the correct client based on `provider`.
 * Callers do not need to know which provider is in use.
 */
export async function callEmbedding(params: {
  texts: string[];
  model: string;
  apiKey: string;
  baseUrl?: string | null;
  dimensions?: number;
  provider: SupportedProvider;
}): Promise<EmbeddingApiResponse> {
  const { provider, ...rest } = params;

  if (provider === "gemini") {
    return callGeminiEmbedding(rest);
  }

  return callOpenAIEmbedding(rest);
}

/**
 * Returns the observability discriminator for embedding calls.
 * Gemini uses its own endpoint; all other providers use the OpenAI-compatible one.
 */
export function getEmbeddingDiscriminator(
  provider: SupportedProvider,
): SupportedProviderDiscriminator {
  return provider === "gemini" ? "gemini:embeddings" : "openai:embeddings";
}

/**
 * Returns true if the error is retryable (rate-limited or server-side failure).
 */
export function isRetryableEmbeddingError(error: unknown): boolean {
  if (
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError
  ) {
    return error.status === 429 || error.status >= 500;
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: string }).code;
    return typeof code === "string" && RETRYABLE_NETWORK_ERROR_CODES.has(code);
  }
  return false;
}
