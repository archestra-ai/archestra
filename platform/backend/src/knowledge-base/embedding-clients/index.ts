import type {
  SupportedProvider,
  SupportedProviderDiscriminator,
} from "@archestra/shared";
import { isConnectionErrno, isTimeoutErrno } from "@/utils/network-errors";
import {
  KnowledgeBaseError,
  UnsupportedEmbeddingProviderError,
  UnusableEmbeddingResponseError,
} from "../errors";
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

  const response = await adapter.call(rest);
  validateEmbeddingResponse(response, {
    provider,
    model: params.model,
    expectedCount: params.inputs.length,
    dimensions: params.dimensions,
  });
  return response;
}

/**
 * Central, provider-agnostic validation of a normalized embedding response —
 * runs for every adapter so a malformed response never reaches pgvector as a
 * crash or a silent bad vector. Throws a typed `UnusableEmbeddingResponseError`
 * (spec item 3) naming the provider/model.
 */
function validateEmbeddingResponse(
  response: EmbeddingApiResponse,
  params: {
    provider: SupportedProvider;
    model: string;
    expectedCount: number;
    dimensions?: number;
  },
): void {
  const { provider, model, expectedCount, dimensions } = params;
  const fail = (reason: string): never => {
    throw new UnusableEmbeddingResponseError(provider, model, reason);
  };

  const data = response?.data;
  if (!Array.isArray(data)) {
    fail("the response contained no embeddings array");
  }
  if (data.length !== expectedCount) {
    fail(`expected ${expectedCount} embedding(s) but received ${data.length}`);
  }
  for (const item of data) {
    const embedding = item?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
      fail("an embedding vector was empty or missing");
    }
    if (!embedding.every((value) => Number.isFinite(value))) {
      fail("an embedding vector contained non-numeric values");
    }
    if (dimensions !== undefined && embedding.length !== dimensions) {
      fail(
        `expected ${dimensions}-dimension vectors but received ${embedding.length}`,
      );
    }
  }
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
  // Typed KB failures are deterministic (bad config, unusable response, an
  // unsupported provider) — retrying can't fix them.
  if (error instanceof KnowledgeBaseError) {
    return false;
  }
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
