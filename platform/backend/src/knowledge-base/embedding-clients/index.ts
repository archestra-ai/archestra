import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@shared";
import type { EmbeddingErrorCode } from "@/types/kb-document";
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
 * Categorize a thrown error into a standard EmbeddingErrorCode.
 */
export function categorizeEmbeddingError(error: unknown): EmbeddingErrorCode {
  let status: number | undefined;
  let message = "";

  if (
    error instanceof AzureEmbeddingError ||
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError
  ) {
    status = error.status;
    message = error.message;
  } else if (error instanceof Error) {
    message = error.message;
    if (
      "status" in error &&
      typeof (error as Record<string, unknown>).status === "number"
    ) {
      status = (error as Record<string, unknown>).status as number;
    }
  } else {
    message = String(error);
  }

  const lowercaseMessage = message.toLowerCase();

  // 1. Dimensions Mismatch
  if (
    lowercaseMessage.includes("dimension") ||
    lowercaseMessage.includes("dimensionality")
  ) {
    return "dimensions_mismatch";
  }

  // 2. Rate Limit
  if (
    status === 429 ||
    lowercaseMessage.includes("rate limit") ||
    lowercaseMessage.includes("rate_limit") ||
    lowercaseMessage.includes("too many requests")
  ) {
    return "rate_limit";
  }

  // 3. Auth Error
  if (
    status === 401 ||
    status === 403 ||
    lowercaseMessage.includes("api key") ||
    lowercaseMessage.includes("unauthorized") ||
    lowercaseMessage.includes("forbidden") ||
    lowercaseMessage.includes("authentication") ||
    lowercaseMessage.includes("invalid key")
  ) {
    return "auth_error";
  }

  // 4. Model Not Found
  if (
    status === 404 ||
    lowercaseMessage.includes("model not found") ||
    lowercaseMessage.includes("does not exist") ||
    lowercaseMessage.includes("not found")
  ) {
    return "model_not_found";
  }

  // 5. Server Error
  if (
    (status !== undefined && status >= 500) ||
    lowercaseMessage.includes("server error") ||
    lowercaseMessage.includes("internal server error")
  ) {
    return "server_error";
  }

  return "unknown";
}
