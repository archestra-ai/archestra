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
  if (error === null || typeof error !== "object") {
    return false;
  }
  const { message, responseBody } = error as {
    message?: unknown;
    responseBody?: unknown;
  };
  return (
    (typeof message === "string" && VERIFICATION_ERROR_PATTERN.test(message)) ||
    (typeof responseBody === "string" &&
      VERIFICATION_ERROR_PATTERN.test(responseBody))
  );
}

// The unverified-org rejection: "Your organization must be verified to
// generate reasoning summaries. Please go to: .../organization/general and
// click on Verify Organization." Matched on the stable middle fragment so
// wording drift around it stays harmless.
const VERIFICATION_ERROR_PATTERN =
  /must be verified to generate reasoning summaries/i;

// Verification can complete at any time and propagates within ~15-30 minutes,
// so the verdict must expire: the retry cost is one wasted round-trip per
// credential per TTL window.
const UNSUPPORTED_VERDICT_TTL = TimeInMs.Hour;
