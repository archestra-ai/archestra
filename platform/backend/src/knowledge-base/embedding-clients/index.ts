import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import { isConnectionErrno, isTimeoutErrno } from "@/utils/network-errors";
import { UnsupportedEmbeddingProviderError } from "../errors";
import { AzureEmbeddingError } from "./azure";
import { BedrockEmbeddingError } from "./bedrock";
import { GeminiEmbeddingError } from "./gemini";
import { OpenAIEmbeddingError } from "./openai";
import { EMBEDDING_ADAPTERS } from "./registry";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

export type { EmbeddingApiResponse, EmbeddingInput };
/** @public — re-exported for testability */
export {
  AzureEmbeddingError,
  BedrockEmbeddingError,
  GeminiEmbeddingError,
  OpenAIEmbeddingError,
};

/**
 * Provider-agnostic embedding call.
 * Dispatches to the correct client via the embedding-adapter registry. A provider
 * with no embedding path is rejected with `UnsupportedEmbeddingProviderError`
 * rather than sent to the OpenAI-compatible client (spec item 2).
 * Accepts both text strings and inline image inputs (multimodal). Image inputs are
 * only meaningful for providers/models that support multimodal embedding (e.g.
 * Gemini gemini-embedding-2-preview); text-only clients throw on non-text inputs.
 */
export async function callEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
  provider: SupportedProvider;
}): Promise<EmbeddingApiResponse> {
  const { provider, ...rest } = params;

  const adapter = EMBEDDING_ADAPTERS[provider];
  if (!adapter) {
    throw new UnsupportedEmbeddingProviderError(provider, params.model);
  }

  return adapter.call(rest);
}

/**
 * Returns the observability discriminator for embedding calls.
 * Falls back to the OpenAI-compatible discriminator for a provider with no
 * adapter (the call itself will reject, so the value is only a placeholder).
 */
export function getEmbeddingDiscriminator(
  provider: SupportedProvider,
): SupportedProviderDiscriminator {
  return EMBEDDING_ADAPTERS[provider]?.discriminator ?? "openai:embeddings";
}

/**
 * Returns true if the error is retryable (rate-limited or server-side failure).
 */
export function isRetryableEmbeddingError(error: unknown): boolean {
  if (
    error instanceof AzureEmbeddingError ||
    error instanceof BedrockEmbeddingError ||
    error instanceof GeminiEmbeddingError ||
    error instanceof OpenAIEmbeddingError
  ) {
    return error.status === 429 || error.status >= 500;
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.) — a dropped/refused
  // connection or a timeout is transient and worth retrying.
  if (error instanceof Error && "code" in error) {
    const code = (error as Error & { code?: string }).code;
    return isConnectionErrno(code) || isTimeoutErrno(code);
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
