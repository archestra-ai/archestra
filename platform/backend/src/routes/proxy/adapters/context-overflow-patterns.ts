import { ArchestraInternalErrorCode } from "@archestra/shared";

/**
 * Shared vocabulary for classifying a provider's 400 message into a normalized
 * internal code. Providers and the OpenAI/Anthropic-compatible gateways fronting
 * them phrase the same condition differently, so keeping one audited pattern list
 * here stops the per-adapter sniffs from drifting (the cause of #3219).
 *
 * Patterns are deliberately conservative: each pairs a context/token noun with an
 * exceed/limit verb. Bare "too long", "context length", and "reduce the length"
 * are intentionally excluded — they appear in unrelated 400s (field validation,
 * remediation prose) and would misclassify them.
 */
const CONTEXT_OVERFLOW_MESSAGE_PATTERNS: RegExp[] = [
  /prompt is too long/i, // Anthropic native
  /prompt too long/i, // Ollama
  /maximum context length/i, // OpenAI / OpenRouter / vLLM
  /exceeded max(?:imum)? context length/i, // Ollama
  /context length exceeded/i,
  /context window exceed(?:s|ed)?/i, // MiniMax "context window exceeds limit"
  /exceed(?:s|ed)? (?:the |your )?context window/i,
  /exceed[a-z]* (?:the |your )?(?:model )?token limit/i, // Kimi "exceeded model token limit"
  /too many tokens/i, // Cohere
];

/**
 * Request-payload byte-size limits, distinct from context-window overflow: the fix
 * is to shrink/split the payload, not the conversation. Maps to RequestTooLarge.
 */
const REQUEST_TOO_LARGE_MESSAGE_PATTERNS: RegExp[] = [
  /message size \d+ exceeds limit/i, // e.g. "total message size 3275158 exceeds limit 2097152"
  /request (?:entity )?too large/i,
  /payload too large/i,
  /exceeds the maximum (?:allowed )?(?:request |payload )?size/i,
];

export function isContextOverflowMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    CONTEXT_OVERFLOW_MESSAGE_PATTERNS.some((p) => p.test(message))
  );
}

export function isRequestTooLargeMessage(message: unknown): boolean {
  return (
    typeof message === "string" &&
    REQUEST_TOO_LARGE_MESSAGE_PATTERNS.some((p) => p.test(message))
  );
}

/**
 * Classify a raw provider error message into a normalized internal code. Context
 * overflow wins over request-size when both somehow match, since shrinking the
 * conversation is the more actionable hint.
 */
export function internalCodeFromProviderMessage(
  message: unknown,
): ArchestraInternalErrorCode | undefined {
  if (isContextOverflowMessage(message)) {
    return ArchestraInternalErrorCode.ContextLengthExceeded;
  }
  if (isRequestTooLargeMessage(message)) {
    return ArchestraInternalErrorCode.RequestTooLarge;
  }
  return undefined;
}
