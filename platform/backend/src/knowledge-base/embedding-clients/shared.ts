import logger from "@/logging";
import { getEncoding, truncateToTokens } from "../tokenizer";
import type { EmbeddingApiResponse, EmbeddingInput } from "./types";

/**
 * Helpers shared by the embedding clients that drive a provider over several
 * independent requests (Bedrock, Cohere direct, …). Each client keeps its own
 * typed error class; the fan-out bookkeeping, input truncation and response
 * normalization live here so the clients cannot drift apart.
 */

/**
 * A fan-out where some independent provider calls succeeded and others failed.
 * Successful vectors are carried back to the embedder so it can persist them
 * and fail (or retry) only the affected chunks instead of discarding and
 * rebilling the entire slice. `status`/`message` come from the first failure in
 * input order; each `failures[].reason` is the provider's typed error for that
 * input, so retry classification can inspect it individually.
 */
export class PartialEmbeddingError extends Error {
  public readonly status: number;
  public readonly successes: Array<{ index: number; embedding: number[] }>;
  public readonly failures: Array<{ index: number; reason: unknown }>;
  public readonly tokens: number;

  constructor(params: {
    successes: Array<{ index: number; embedding: number[] }>;
    failures: Array<{ index: number; reason: unknown }>;
    tokens: number;
    /**
     * Maps a raw failure reason onto the client's typed error (a provider
     * client passes its own normalizer). Omitted when the reasons are already
     * typed — they are then kept exactly as given.
     */
    toTypedError?: (reason: unknown) => unknown;
  }) {
    const toTypedError = params.toTypedError ?? ((reason) => reason);
    const orderedFailures = params.failures
      .map((failure) => ({ ...failure, reason: toTypedError(failure.reason) }))
      .sort((a, b) => a.index - b.index);
    const first = describeFailure(
      orderedFailures[0]?.reason ?? toTypedError(undefined),
    );
    super(first.message);
    this.name = "PartialEmbeddingError";
    this.status = first.status;
    this.successes = [...params.successes].sort((a, b) => a.index - b.index);
    this.failures = orderedFailures;
    this.tokens = params.tokens;
  }
}

/** Wrap a provider's vectors in the normalized, OpenAI-shaped response. */
export function toEmbeddingApiResponse(params: {
  embeddings: number[][];
  tokens: number;
  model: string;
}): EmbeddingApiResponse {
  const { embeddings, tokens, model } = params;
  return {
    object: "list",
    data: embeddings.map((embedding, index) => ({
      object: "embedding",
      embedding,
      index,
    })),
    model,
    usage: { prompt_tokens: tokens, total_tokens: tokens },
  };
}

/**
 * Split the settled results of a one-call-per-input fan-out into the vectors
 * that arrived and the inputs that failed, both keyed by input index.
 */
export function collectPartialEmbeddingResults(
  settled: PromiseSettledResult<number[]>[],
): {
  successes: Array<{ index: number; embedding: number[] }>;
  failures: Array<{ index: number; reason: unknown }>;
} {
  const successes: Array<{ index: number; embedding: number[] }> = [];
  const failures: Array<{ index: number; reason: unknown }> = [];
  settled.forEach((result, index) => {
    if (result.status === "fulfilled") {
      successes.push({ index, embedding: result.value });
    } else {
      failures.push({ index, reason: result.reason });
    }
  });
  return { successes, failures };
}

/**
 * Truncate text inputs to fit a model's hard per-request token limit. We count
 * cl100k tokens (the KB's tokenizer) but the model counts its own, so only a
 * margin-reduced share of the limit is used. Unlike a provider's server-side
 * truncation this loses content locally — warn with the count so the
 * degradation is visible.
 */
export function truncateTextInputsToTokens(params: {
  inputs: EmbeddingInput[];
  model: string;
  maxInputTextTokens?: number;
  logPrefix: string;
}): EmbeddingInput[] {
  const { inputs, model, maxInputTextTokens, logPrefix } = params;
  if (maxInputTextTokens === undefined) {
    return inputs;
  }
  const tokenBudget = Math.floor(maxInputTextTokens * TOKEN_LIMIT_MARGIN);
  const encoding = getEncoding();
  let truncatedCount = 0;
  const prepared = inputs.map((input) => {
    if (typeof input !== "string") {
      return input;
    }
    const truncated = truncateToTokens(encoding, input, tokenBudget);
    if (truncated !== input) {
      truncatedCount++;
    }
    return truncated;
  });
  if (truncatedCount > 0) {
    logger.warn(
      { model, truncatedCount, maxInputTextTokens },
      `${logPrefix} Truncated text inputs over the model's token limit`,
    );
  }
  return prepared;
}

/**
 * Truncate a text to a hard character cap. A string of N UTF-16 code units is
 * at most N code points, so slicing by `length` can never exceed a cap the
 * server counts in code points; a trailing lone high surrogate (a split
 * astral character) is stripped rather than sent broken.
 */
export function truncateToChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  const truncated = text.slice(0, maxChars);
  const lastCode = truncated.charCodeAt(truncated.length - 1);
  return lastCode >= 0xd800 && lastCode <= 0xdbff
    ? truncated.slice(0, -1)
    : truncated;
}

/** Decoded byte size of a base64 payload, without decoding it. */
export function base64DecodedBytes(data: string): number {
  return Math.floor((data.length * 3) / 4);
}

/** Split an array into consecutive slices of at most `size` items. */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
}

// ===== Internal helpers =====

function describeFailure(reason: unknown): { status: number; message: string } {
  const status =
    (reason as { status?: number } | undefined)?.status ??
    (reason as { statusCode?: number } | undefined)?.statusCode ??
    500;
  const message =
    reason instanceof Error
      ? reason.message
      : reason === undefined
        ? "Embedding failed"
        : String(reason);
  return { status, message };
}

// ===== Internal constants =====

/**
 * Share of a model's token limit the local cl100k count may fill. The model's
 * own tokenizer segments differently, so aiming at the exact limit would still
 * trip its validation error on unlucky inputs.
 */
const TOKEN_LIMIT_MARGIN = 0.85;
