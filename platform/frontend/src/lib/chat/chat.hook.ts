/**
 * Derived hooks for the Context Window Visualizer.
 *
 * Builds on the raw session values in ChatSession so callers get a single,
 * stable object rather than stitching together three separate fields.
 */
import type { ContextWindowBreakdown } from "@shared";
import type { ChatSession } from "./global-chat.context";

export type ContextWindowState = {
  /**
   * Current prompt-token occupancy for the indicator ring.
   *
   * Priority order (highest wins):
   * 1. Provider's exact input-token count from the most recent per-step
   *    `data-token-usage` event (authoritative after the model responds).
   * 2. Backend estimate from `data-context-window-estimate` (seeds the bar
   *    before the model replies and after a compaction drop).
   * 3. `null` — no data yet; the indicator is hidden.
   */
  tokensUsed: number | null;

  /**
   * Model's advertised context-window size, used as the denominator for the
   * ring fill percentage. Sourced from the streamed breakdown so it always
   * matches the model that was actually used this turn.
   *
   * `null` when the breakdown has not arrived yet or the model's context length
   * is unknown — the ring is hidden in both cases.
   */
  maxTokens: number | null;

  /**
   * Full per-category breakdown for the visualizer panel, or `null` when not
   * yet available (new conversation, first turn, or stale between turns).
   */
  breakdown: ContextWindowBreakdown | null;
};

/**
 * Derives the context window indicator state from the raw session values.
 *
 * Accepts the relevant slice of a `ChatSession` so it can be called from any
 * component that already holds the session (no extra hook subscription).
 *
 * Returns `null` when the session is not yet available.
 */
export function deriveContextWindowState(
  session:
    | Pick<ChatSession, "contextTokensUsed" | "tokenUsage" | "contextWindow">
    | null
    | undefined,
): ContextWindowState {
  if (!session) {
    return { tokensUsed: null, maxTokens: null, breakdown: null };
  }

  const { contextTokensUsed, tokenUsage, contextWindow } = session;

  // contextTokensUsed is already the best available number: it is set by both
  // the turn-start estimate and the per-step usage events, with usage events
  // winning because they arrive later and overwrite the estimate.
  const tokensUsed = contextTokensUsed ?? tokenUsage?.totalTokens ?? null;

  // contextLength from the breakdown is more reliable than the model DB row
  // because it reflects the model actually used this turn (after any swap).
  const maxTokens = contextWindow?.contextLength ?? null;

  return { tokensUsed, maxTokens, breakdown: contextWindow ?? null };
}
