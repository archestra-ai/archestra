import { CONTEXT_COMPACTION_AUTO_THRESHOLD } from "@archestra/shared";

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

/** Usage-band text color, escalating as the window fills. */
export function usageTextColor(percent: number): string {
  if (percent >= USAGE_BANDS.critical) return "text-red-500";
  if (percent >= USAGE_BANDS.warning) return "text-orange-500";
  if (percent >= USAGE_BANDS.elevated) return "text-yellow-500";
  return "text-emerald-500";
}

/** Usage-band stroke color for the indicator ring's progress arc. */
export function usageStrokeColor(percent: number): string {
  if (percent >= USAGE_BANDS.critical) return "stroke-red-500";
  if (percent >= USAGE_BANDS.warning) return "stroke-orange-500";
  if (percent >= USAGE_BANDS.elevated) return "stroke-yellow-500";
  return "stroke-emerald-500";
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
