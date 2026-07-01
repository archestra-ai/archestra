import type { ContextWindowBreakdown } from "@archestra/shared";

export class ContextWindowExceededError extends Error {
  readonly model: string;
  /** Estimated tokens of the assembled request (the size the user sees). */
  readonly estimatedTokens: number;
  readonly contextLength: number;

  constructor(params: {
    model: string;
    estimatedTokens: number;
    contextLength: number;
  }) {
    super(formatContextWindowExceededMessage(params));
    this.name = "ContextWindowExceededError";
    this.model = params.model;
    this.estimatedTokens = params.estimatedTokens;
    this.contextLength = params.contextLength;
  }
}

/**
 * Reject a turn whose assembled prompt cannot fit the model's context window
 * before the provider call, so the user gets an actionable message instead of a
 * generic provider rejection after a slow round trip.
 *
 * Gates on the tokenizer-counted budget only — system prompt, tools, messages,
 * tool results — and deliberately EXCLUDES the `files` segment. File tokens are
 * a byte-ratio heuristic (see estimate-message-tokens.ts) that can over-count,
 * so gating on them would falsely reject a request the provider would accept.
 * Oversized file payloads are bounded separately by the request-size guard and,
 * failing that, by the provider's own rejection.
 */
export function assertWithinContextWindow(
  breakdown: ContextWindowBreakdown,
): void {
  if (breakdown.contextLength === null) {
    return;
  }
  const gateTokens = breakdown.segments
    .filter((segment) => segment.category !== "files")
    .reduce((sum, segment) => sum + segment.tokens, 0);
  if (gateTokens > breakdown.contextLength) {
    throw new ContextWindowExceededError({
      model: breakdown.model,
      estimatedTokens: breakdown.usedTokens,
      contextLength: breakdown.contextLength,
    });
  }
}

function formatContextWindowExceededMessage(params: {
  model: string;
  estimatedTokens: number;
  contextLength: number;
}): string {
  const used = params.estimatedTokens.toLocaleString("en-US");
  const limit = params.contextLength.toLocaleString("en-US");
  return (
    `This message is about ${used} tokens, which is too long for ${params.model}. ` +
    `The most it can accept is ${limit} tokens. ` +
    `Please shorten your message or start a new chat.`
  );
}
