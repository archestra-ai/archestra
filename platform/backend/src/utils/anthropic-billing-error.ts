import { AnthropicErrorTypes } from "@archestra/shared";

/**
 * True when an Anthropic error means the key's remaining usage balance is too
 * low (out of credit OR over a usage/spend limit) — both terminal. Out of credit
 * is HTTP 402 `billing_error` / a legacy 400 "credit balance is too low"; the
 * usage-limit case is a plain 400 with a non-standard `api_validation_error`
 * type, so only the body message identifies it — status/type alone aren't enough.
 */
export function isAnthropicBillingBlock(params: {
  status?: number | null;
  type?: string | null;
  message?: string | null;
}): boolean {
  const { status, type, message } = params;
  if (type === AnthropicErrorTypes.BILLING || status === 402) {
    return true;
  }
  // Rate limits phrase themselves with "rate limit", so they don't match here
  // and stay retriable.
  return messageIncludesAny(message, BILLING_BLOCK_PHRASES);
}

/** Case-insensitive substring test — the phrases have no regex features. */
function messageIncludesAny(
  message: string | null | undefined,
  phrases: readonly string[],
): boolean {
  if (typeof message !== "string") return false;
  const haystack = message.toLowerCase();
  return phrases.some((phrase) => haystack.includes(phrase));
}

// All phrases are lowercase (matched against a lowercased message).
const BILLING_BLOCK_PHRASES = [
  "credit balance is too low",
  "usage limit",
  "spend limit",
  "spending limit",
] as const;
