import type { EmbeddingErrorCode } from "@/types/kb-document";
import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@shared";
import { AzureEmbeddingError, callAzureEmbedding } from "./azure";
import { callGeminiEmbedding, GeminiEmbeddingError } from "./gemini";
import { callOpenAIEmbedding, OpenAIEmbeddingError } from "./openai";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

export type { EmbeddingApiResponse, EmbeddingInput };
/** @public — re-exported for testability */
export { AzureEmbeddingError, GeminiEmbeddingError, OpenAIEmbeddingError };

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
 * Accepts both text strings and inline image inputs (multimodal).
 * Image inputs are only meaningful for providers/models that support multimodal
 * embedding (e.g. Gemini gemini-embedding-2-preview). OpenAI-compatible providers
 * throw on non-text inputs — images should never reach them in normal operation.
 */
export async function callEmbedding(params: {
  inputs: EmbeddingInput[];
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

  if (provider === "azure") {
    return callAzureEmbedding(rest);
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
    error instanceof AzureEmbeddingError ||
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

export function getEmbeddingRetryDelayMs(
  error: unknown,
  fallbackDelayMs: number,
): number {
  if (
    error instanceof AzureEmbeddingError &&
    error.retryAfterMs !== undefined
  ) {
    return error.retryAfterMs;
  }

  return fallbackDelayMs;
}

/**
 * Categorizes an embedding error into a structured error code.
 * Maps API errors to an EmbeddingErrorCode enum value for persisting in the DB
 * and displaying human-readable messages on the frontend.
 */
export function categorizeEmbeddingError(error: unknown): EmbeddingErrorCode {
  if (
    error instanceof AzureEmbeddingError ||
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError
  ) {
    const status = error.status;
    const message = error.message.toLowerCase();

    if (status === 429 || message.includes("rate limit")) return "rate_limit";
    if (status === 401 || status === 403 || message.includes("api key") || message.includes("unauthorized") || message.includes("forbidden")) return "auth_error";
    if (status >= 500) return "server_error";
    if (message.includes("dimension") || message.includes("dimensionality")) return "dimensions_mismatch";
    if ((message.includes("model") && (message.includes("not found") || message.includes("does not exist") || message.includes("not supported"))) || status === 404) return "model_not_found";
    return "unknown";
  }
  return "unknown";
}
