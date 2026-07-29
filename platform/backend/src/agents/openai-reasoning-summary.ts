// OpenAI reasoning-summary capability gate.
//
// Responses-routed OpenAI reasoning models bill reasoning tokens whether or
// not summaries are requested, so agent turns ask for them ("auto") to surface
// the thinking that is already paid for. But `reasoning.summary` rejects the
// whole request for unverified OpenAI organizations ("Your organization must
// be verified to generate reasoning summaries"), so turn builders consult a
// per-credential negative cache before requesting, and the agent-run-stream
// recovery loop detects the rejection mid-turn, retries without summaries, and
// records the verdict here through its caller.

import { TimeInMs } from "@archestra/shared";
import { type AllowedCacheKey, CacheKey, cacheManager } from "@/cache-manager";
import logger from "@/logging";

/**
 * Cache key for one credential's verdict. `llmApiKeyId` must be the resolved
 * credential id (`chatApiKeyId` from `createLLMModelForAgent`), not the
 * agent's configured key: resolution can land on a personal/team/org key or
 * substitute a per-user ChatGPT-subscription credential, and the verified-org
 * verdict belongs to the credential the turn actually ran on. Null means an
 * environment-variable key.
 */
export function openAiReasoningSummaryCacheKey(params: {
  organizationId: string;
  llmApiKeyId: string | null;
}): AllowedCacheKey {
  const { organizationId, llmApiKeyId } = params;
  return `${CacheKey.OpenaiReasoningSummaryUnsupported}-${organizationId}:${llmApiKeyId ?? "env"}`;
}

export async function isOpenAiReasoningSummaryMarkedUnsupported(
  key: AllowedCacheKey,
): Promise<boolean> {
  return (await cacheManager.get<boolean>(key)) === true;
}

export async function markOpenAiReasoningSummaryUnsupported(
  key: AllowedCacheKey,
): Promise<void> {
  try {
    await cacheManager.set(key, true, UNSUPPORTED_VERDICT_TTL);
  } catch (error) {
    // Best-effort: a lost negative-cache write only costs another wasted
    // round-trip on a later turn; never fail the in-flight recovery over it.
    logger.warn(
      { error, key },
      "Failed to cache the reasoning-summary unsupported verdict",
    );
  }
}

export function isReasoningSummaryVerificationError(error: unknown): boolean {
  // SDK wrappers can nest the provider rejection under `cause` (a RetryError,
  // a stream-error wrapper), so walk a bounded chain instead of trusting the
  // top-level shape.
  let current: unknown = error;
  for (
    let depth = 0;
    depth < MAX_ERROR_CAUSE_DEPTH &&
    current !== null &&
    typeof current === "object";
    depth++
  ) {
    if (isVerificationRejection(current)) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function isVerificationRejection(error: object): boolean {
  const { message, responseBody, data } = error as {
    message?: unknown;
    responseBody?: unknown;
    data?: unknown;
  };
  if (typeof message === "string" && VERIFICATION_ERROR_PATTERN.test(message)) {
    return true;
  }
  if (
    typeof responseBody === "string" &&
    (VERIFICATION_ERROR_PATTERN.test(responseBody) ||
      REJECTED_SUMMARY_PARAM_PATTERN.test(responseBody))
  ) {
    return true;
  }
  return rejectedOpenAiParam(data) === "reasoning.summary";
}

// APICallError.data carries the parsed OpenAI error body ({ error: { message,
// type, param, code } }) when the SDK could parse the response.
function rejectedOpenAiParam(data: unknown): string | null {
  if (data === null || typeof data !== "object") {
    return null;
  }
  const inner = (data as { error?: unknown }).error;
  if (inner === null || typeof inner !== "object") {
    return null;
  }
  const param = (inner as { param?: unknown }).param;
  return typeof param === "string" ? param : null;
}

// The unverified-org rejection: "Your organization must be verified to
// generate reasoning summaries. Please go to: .../organization/general and
// click on Verify Organization." Matched on the stable middle fragment so
// wording drift around it stays harmless.
const VERIFICATION_ERROR_PATTERN =
  /must be verified to generate reasoning summaries/i;

// Wording-drift fallback: `reasoning.summary` only appears in our requests
// because this module's callers added it, so any 400 that names it as the
// offending param is recoverable by stripping the option, whatever the
// message says.
const REJECTED_SUMMARY_PARAM_PATTERN = /"param"\s*:\s*"reasoning\.summary"/;

// Wrapper errors nest the provider rejection under `cause`; five levels covers
// SDK wrapping depth while keeping self-referential chains terminating.
const MAX_ERROR_CAUSE_DEPTH = 5;

// Verification can complete at any time and propagates within ~15-30 minutes,
// so the verdict must expire: the retry cost is one wasted round-trip per
// credential per TTL window.
const UNSUPPORTED_VERDICT_TTL = TimeInMs.Hour;
