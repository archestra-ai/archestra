import {
  CONTEXT_COMPACTION_AUTO_THRESHOLD,
  type ContextWindowBreakdown,
} from "@archestra/shared";

// ============================================================================
// Public interface
// ============================================================================

/** The share of the window (in percent) at which auto-compaction fires. */
export const AUTO_COMPACT_PERCENT = Math.round(
  CONTEXT_COMPACTION_AUTO_THRESHOLD * 100,
);

/**
 * How full the context window is, plus the headroom the user actually cares
 * about: how much is left before auto-compaction takes over, not before the
 * window is physically full.
 */
export interface ContextWindowStatus {
  /** Share of the window consumed, 0–100. */
  usedPercent: number;
  /**
   * Points of the full window still free before auto-compaction fires, 0–80.
   * Phrased as "N% of context remaining until auto-compact".
   */
  remainingPercent: number;
  /** Auto-compaction will run on the next turn. */
  atAutoCompact: boolean;
  /** Close enough to auto-compaction that compacting now is worth offering. */
  nearAutoCompact: boolean;
}

/**
 * Resolves the single authoritative `{ tokensUsed, maxTokens }` pair shared by
 * the composer's circular indicator, its hover tooltip, and the breakdown
 * dialog:
 * - `tokensUsed` prefers the live session counter (which is refined by
 *   post-step `data-token-usage` events and updated by compaction) and falls
 *   back to the breakdown's estimate when the counter is zero.
 * - `maxTokens` prefers the currently selected model's effective context
 *   window (`selectedModelContextLength`) so switching models in the composer
 *   immediately updates both the ring and the tooltip/panel in lockstep,
 *   falling back to the breakdown's window only while the catalog loads.
 */
export function resolveContextWindowUsage(params: {
  tokensUsed?: number;
  maxTokens?: number | null;
  breakdown?: ContextWindowBreakdown | null;
}): {
  tokensUsed: number;
  maxTokens: number | null;
} {
  const { tokensUsed, maxTokens, breakdown } = params;
  const resolvedUsed =
    typeof tokensUsed === "number" && tokensUsed > 0
      ? tokensUsed
      : (breakdown?.usedTokens ?? 0);
  const resolvedMax =
    typeof maxTokens === "number" && maxTokens > 0
      ? maxTokens
      : (breakdown?.contextLength ?? null);
  return {
    tokensUsed: resolvedUsed,
    maxTokens: resolvedMax,
  };
}

/**
 * Reconciles a `ContextWindowBreakdown` with the latest resolved `tokensUsed`
 * and `maxTokens` so the breakdown panel's headline, stacked bar, free space,
 * and auto-compaction headroom always match the composer's indicator ring and
 * hover tooltip (e.g. after provider usage refinement or a model switch).
 */
export function reconcileContextWindowBreakdown(
  breakdown: ContextWindowBreakdown,
  params: {
    tokensUsed?: number;
    maxTokens?: number | null;
  },
): ContextWindowBreakdown {
  const usedTokens =
    typeof params.tokensUsed === "number" && params.tokensUsed > 0
      ? params.tokensUsed
      : breakdown.usedTokens;
  const contextLength =
    typeof params.maxTokens === "number" && params.maxTokens > 0
      ? params.maxTokens
      : breakdown.contextLength;

  if (
    usedTokens === breakdown.usedTokens &&
    contextLength === breakdown.contextLength
  ) {
    return breakdown;
  }

  const freeTokens = contextLength !== null ? contextLength - usedTokens : null;
  const usedPercent =
    contextLength !== null && contextLength > 0
      ? Math.min((usedTokens / contextLength) * 100, 100)
      : null;
  const estimatedInputCostUsd =
    breakdown.estimatedInputCostUsd !== null && breakdown.usedTokens > 0
      ? (breakdown.estimatedInputCostUsd / breakdown.usedTokens) * usedTokens
      : breakdown.estimatedInputCostUsd;

  const originalTotal = breakdown.segments.reduce(
    (sum, s) => sum + s.tokens,
    0,
  );
  let scaledSegments = breakdown.segments;
  if (usedTokens !== breakdown.usedTokens && originalTotal > 0) {
    scaledSegments = breakdown.segments.map((s) => ({
      ...s,
      tokens: Math.round((s.tokens / originalTotal) * usedTokens),
      items: s.items?.map((item) => ({
        ...item,
        tokens: Math.round((item.tokens / originalTotal) * usedTokens),
      })),
    }));
    const roundedTotal = scaledSegments.reduce((sum, s) => sum + s.tokens, 0);
    const remainder = usedTokens - roundedTotal;
    if (remainder !== 0 && scaledSegments.length > 0) {
      let largestIndex = 0;
      for (let i = 1; i < scaledSegments.length; i++) {
        if (scaledSegments[i].tokens > scaledSegments[largestIndex].tokens) {
          largestIndex = i;
        }
      }
      scaledSegments[largestIndex] = {
        ...scaledSegments[largestIndex],
        tokens: Math.max(0, scaledSegments[largestIndex].tokens + remainder),
      };
    }
  }

  return {
    ...breakdown,
    contextLength,
    usedTokens,
    freeTokens,
    usedPercent,
    estimatedInputCostUsd,
    segments: scaledSegments,
  };
}

export function getContextWindowStatus(
  tokensUsed: number,
  maxTokens: number | null,
): ContextWindowStatus {
  const usedPercent =
    maxTokens && maxTokens > 0
      ? Math.min((tokensUsed / maxTokens) * 100, 100)
      : 0;

  return {
    usedPercent,
    remainingPercent: Math.max(AUTO_COMPACT_PERCENT - usedPercent, 0),
    atAutoCompact: usedPercent >= AUTO_COMPACT_PERCENT,
    nearAutoCompact: usedPercent >= USAGE_BANDS.warning,
  };
}

/**
 * The one sentence describing context headroom, shared by every surface that
 * mentions it (indicator tooltip, breakdown panel). Keeping it in one place is
 * what stops the panel and the tooltip drifting into two different numbers for
 * the same thing.
 */
export function describeContextHeadroom(status: ContextWindowStatus): string {
  return status.atAutoCompact
    ? "Auto-compact runs on your next message."
    : `${Math.round(status.remainingPercent)}% of context remaining until auto-compact.`;
}

/**
 * How far the conversation has travelled toward auto-compaction, 0–100 — a
 * full ring means it fires on the next turn. Deliberately *not* the share of
 * the window used: this drives the gauge beside the headroom sentence, so it
 * has to count down to the same event that sentence names.
 */
export function autoCompactProgressPercent(
  status: ContextWindowStatus,
): number {
  return Math.min((status.usedPercent / AUTO_COMPACT_PERCENT) * 100, 100);
}

/**
 * Usage-band text color, escalating as the window fills.
 */
export function usageTextColor(percent: number): string {
  if (percent >= USAGE_BANDS.critical) return "text-red-600 dark:text-red-400";
  if (percent >= USAGE_BANDS.warning)
    return "text-orange-600 dark:text-orange-400";
  if (percent >= USAGE_BANDS.elevated)
    return "text-yellow-600 dark:text-yellow-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/**
 * Usage-band stroke color for the indicator ring's progress arc.
 */
export function usageStrokeColor(percent: number): string {
  if (percent >= USAGE_BANDS.critical)
    return "stroke-red-600 dark:stroke-red-400";
  if (percent >= USAGE_BANDS.warning)
    return "stroke-orange-600 dark:stroke-orange-400";
  if (percent >= USAGE_BANDS.elevated)
    return "stroke-yellow-600 dark:stroke-yellow-400";
  return "stroke-emerald-600 dark:stroke-emerald-400";
}

/** Compact token count: 85_600 → "85.6k", 1_000_000 → "1.0M". */
export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toString();
}

// ============================================================================
// Internal
// ============================================================================

/**
 * Shared escalation bands for every context-usage surface (ring, headline
 * percentage, compaction nudge). `warning` deliberately sits just under
 * {@link AUTO_COMPACT_PERCENT} so the UI turns amber while the user can still
 * choose to compact on their own terms.
 */
const USAGE_BANDS = {
  elevated: 50,
  warning: 75,
  critical: 90,
} as const;
