import type {
  ModelInputModality,
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
import { BedrockEmbeddingError, BedrockPartialEmbeddingError } from "./bedrock";
import { findBedrockEmbeddingModel } from "./bedrock-models";
import { GeminiEmbeddingError } from "./gemini";
import { OpenAIEmbeddingError } from "./openai";
import { EMBEDDING_ADAPTERS } from "./registry";
import type {
  EmbeddingApiResponse,
  EmbeddingInput,
  EmbeddingPurpose,
} from "./types";

export type { EmbeddingApiResponse, EmbeddingInput };
/** @public — re-exported for testability */
export {
  AzureEmbeddingError,
  BedrockEmbeddingError,
  BedrockPartialEmbeddingError,
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
 * Gemini gemini-embedding-2); text-only clients throw on non-text inputs.
 */
export async function callEmbedding(params: {
  inputs: EmbeddingInput[];
  model: string;
  apiKey: string | null;
  baseUrl?: string | null;
  dimensions?: number;
  provider: SupportedProvider;
  /**
   * Document vs query embedding — clients that condition the vector on it
   * (Bedrock/Cohere via `input_type`) receive it; the rest ignore it.
   * Defaults to the document side when omitted.
   */
  purpose?: EmbeddingPurpose;
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
 * Input modalities the embedding client for `provider` can actually drive for
 * `model` — the client-side half of the capability gate. `null` means "no
 * clamp": the client handles whatever the models table declares. Everything
 * else is text-only except the models the KB's own clients have an image path
 * for; an unknown model degrades to text so a mis-tagged row can never make
 * connectors ingest images the embed call will reject. The Gemini client
 * forwards inline images for ANY model, so its image capability is allowlisted
 * per model — Gemini's text-only embedding models reject images at the API.
 */
export function getEmbeddingClientInputModalities(
  provider: SupportedProvider,
  model: string,
): ModelInputModality[] | null {
  if (provider === "gemini") {
    return GEMINI_IMAGE_CAPABLE_EMBEDDING_MODELS.has(
      model.replace(/^models\//, ""),
    )
      ? null
      : ["text"];
  }
  if (provider === "bedrock") {
    const entry = findBedrockEmbeddingModel(model);
    return entry ? [...entry.inputModalities] : ["text"];
  }
  return ["text"];
}

/**
 * Image MIME types the embedding client for `provider` can send to `model`, or
 * `null` for no per-format restriction. Only meaningful when the resolved
 * input modalities include "image": Bedrock's multimodal models and Gemini's
 * embedding API take JPEG/PNG only (anything else — a GIF, say — is a provider
 * error that fails the document). Connectors
 * skip other formats at ingestion and the embedder skips them at embed time.
 */
export function getEmbeddingClientAcceptedImageMimeTypes(
  provider: SupportedProvider,
  model: string,
): string[] | null {
  if (provider === "bedrock") {
    const entry = findBedrockEmbeddingModel(model);
    return entry?.acceptedImageMimeTypes
      ? [...entry.acceptedImageMimeTypes]
      : null;
  }
  if (
    provider === "gemini" &&
    GEMINI_IMAGE_CAPABLE_EMBEDDING_MODELS.has(model.replace(/^models\//, ""))
  ) {
    return [...GEMINI_ACCEPTED_IMAGE_MIME_TYPES];
  }
  return null;
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
  // A total fan-out outage is safe to retry. Mixed results require the
  // embedder's targeted retry path so successful InvokeModel calls are never
  // repeated.
  if (error instanceof BedrockPartialEmbeddingError) {
    return (
      error.successes.length === 0 &&
      error.failures.length > 0 &&
      error.failures.every((failure) =>
        isRetryableEmbeddingError(failure.reason),
      )
    );
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

// ===== Internal constants =====

/**
 * Gemini embedding models the KB's Gemini client can drive image inputs for
 * (matched with any "models/" prefix stripped). A future multimodal Gemini
 * embedding model needs an entry here before connectors will ingest images for
 * it — safe-by-default, same as Bedrock's unknown-model→text degradation.
 */
const GEMINI_IMAGE_CAPABLE_EMBEDDING_MODELS = new Set(["gemini-embedding-2"]);

/**
 * Gemini's documented inline-image formats. The SDK forwards any payload
 * as-is, so the format gate has to live here: an undocumented format (GIF)
 * reaching the API fails the embed call and with it the whole document.
 */
const GEMINI_ACCEPTED_IMAGE_MIME_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
];
