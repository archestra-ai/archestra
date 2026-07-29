/**
 * Workaround for providers whose rate limiter charges a request's `max_tokens`
 * reservation against a per-minute token bucket rather than billing only the
 * tokens actually generated (Groq).
 *
 * On those providers a request is rejected when `prompt + reservation` exceeds
 * the credential's whole allowance, so a one-word message fails while the
 * conversation is nearly empty — and neither trimming messages nor starting a
 * new chat helps, because the reservation is constant. The rejection does name
 * the allowance ("Limit 6000, Requested 6719"), so the budget can be refitted
 * from the provider's own numbers and the turn retried once.
 *
 * Deriving the ceiling from the rejection (rather than a configured constant)
 * keeps it correct across tiers: buckets differ per model and per plan, so any
 * static value is either too small for a paid tier or too large for a free one.
 */

/** The allowance and the rejected request's size, as reported by the provider. */
export interface TokenBucketLimit {
  /** Total tokens the credential may spend per window. */
  limitTokens: number;
  /** Tokens the provider counted for the rejected request (prompt + reservation). */
  requestedTokens: number;
}

/**
 * Parse the per-minute token allowance from a provider's token-bucket
 * rejection. Matches Groq's phrasing:
 * "on tokens per minute (TPM): Limit 6000, Requested 6719".
 *
 * Deliberately only matches TPM. A tokens-per-day rejection reports a budget
 * that a smaller output reservation cannot meaningfully recover, so retrying
 * there would just burn another request.
 */
export function parseTokenBucketError(error: unknown): TokenBucketLimit | null {
  const body = readErrorBody(error);
  if (!body) return null;

  const match = body.match(
    /tokens per minute \(TPM\)[^:]*:\s*Limit (\d+), Requested (\d+)/i,
  );
  if (!match) return null;

  const limitTokens = Number.parseInt(match[1], 10);
  const requestedTokens = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(limitTokens) || limitTokens <= 0) return null;
  if (!Number.isSafeInteger(requestedTokens) || requestedTokens <= 0) {
    return null;
  }
  return { limitTokens, requestedTokens };
}

/**
 * Recompute the output-token budget so `prompt + reservation` fits the reported
 * allowance.
 *
 * The prompt is whatever the provider counted that was not our reservation, so
 * the room left for output is `limit - prompt`, shrunk by
 * {@link TOKEN_BUCKET_HEADROOM_RATIO} because the provider's tokenizer and ours
 * disagree slightly and the retry only gets one attempt.
 *
 * Returns null when a retry cannot help: the prompt alone already fills the
 * bucket, the refit would not actually shrink the request, or the reservation
 * evidently was not counted (so the budget is not what blew the limit).
 */
export function refitOutputBudgetToTokenBucket(params: {
  bucket: TokenBucketLimit;
  currentMaxOutputTokens: number;
}): number | null {
  const { bucket, currentMaxOutputTokens } = params;
  if (currentMaxOutputTokens <= 0) return null;

  const promptTokens = bucket.requestedTokens - currentMaxOutputTokens;
  // A negative prompt means the reservation was not part of the counted total,
  // so shrinking it would not change the outcome.
  if (promptTokens < 0) return null;

  const available = bucket.limitTokens - promptTokens;
  const fitted = Math.floor(available * TOKEN_BUCKET_HEADROOM_RATIO);

  // The prompt alone leaves no usable room — surfacing the error beats retrying
  // into a generation too short to be worth anything.
  if (fitted < MIN_REFIT_OUTPUT_TOKENS) return null;
  if (fitted >= currentMaxOutputTokens) return null;
  return fitted;
}

/** Shrink the refitted budget so tokenizer disagreement cannot re-trip the limit. */
const TOKEN_BUCKET_HEADROOM_RATIO = 0.9;

/** Below this, a retry buys a generation too truncated to be useful. */
const MIN_REFIT_OUTPUT_TOKENS = 512;

function readErrorBody(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "responseBody" in error &&
    typeof (error as { responseBody?: unknown }).responseBody === "string"
  ) {
    return (error as { responseBody: string }).responseBody;
  }
  return error instanceof Error ? error.message : undefined;
}
