"use client";

import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  usageStrokeColor,
  usageTextColor,
} from "@/lib/chat/context-window-status";
import { cn } from "@/lib/utils";

// ============================================================================
// Progress ring — the shared circular gauge
// ============================================================================

/**
 * Geometry per size. Kept explicit rather than derived so the composer's ring
 * stays pixel-identical; `xs` is sized for an inline glyph slot beside
 * `text-xs` copy, as in the context window panel's notes.
 */
const RING_GEOMETRY = {
  xs: { box: "size-4", viewBox: 16, radius: 6, stroke: 2 },
  sm: { box: "size-5", viewBox: 20, radius: 8, stroke: 2 },
  md: { box: "size-6", viewBox: 24, radius: 10, stroke: 2.5 },
} as const;

export type ProgressRingSize = keyof typeof RING_GEOMETRY;

/**
 * A circular progress gauge. Used for the composer's context indicator and,
 * at `xs`, wherever a note needs to show the same value it is talking about
 * rather than a decorative icon.
 */
export function ProgressRing({
  percent,
  size = "sm",
  className,
  arcClassName,
  trackClassName = "stroke-muted",
  children,
}: {
  /** Fill, 0–100. Clamped. */
  percent: number;
  size?: ProgressRingSize;
  className?: string;
  /** Stroke color class for the filled arc. */
  arcClassName?: string;
  /** Stroke color class for the unfilled track. Override on tinted surfaces,
   *  where the default disappears into the background. */
  trackClassName?: string;
  children?: ReactNode;
}) {
  const { box, viewBox, radius, stroke } = RING_GEOMETRY[size];
  const center = viewBox / 2;
  const circumference = 2 * Math.PI * radius;
  const filled = Math.min(Math.max(percent, 0), 100);
  const strokeDashoffset = circumference - (filled / 100) * circumference;

  return (
    <div
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center",
        box,
        className,
      )}
    >
      <svg
        className="absolute inset-0 -rotate-90"
        width={viewBox}
        height={viewBox}
        viewBox={`0 0 ${viewBox} ${viewBox}`}
        aria-hidden="true"
      >
        {/* Track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className={trackClassName}
        />
        {/* Progress arc */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={cn("transition-all duration-300", arcClassName)}
        />
      </svg>
      {children}
    </div>
  );
}

// ============================================================================
// Context indicator — the composer's token-aware ring
// ============================================================================

interface ContextIndicatorProps {
  /** Current prompt-token estimate or provider count. */
  tokensUsed: number;
  /** Maximum context window size for the model. */
  maxTokens: number | null;
  /** Optional className for the container */
  className?: string;
  /** Size of the indicator. */
  size?: "sm" | "md";
}

/**
 * Circular progress ring showing context-window usage. Purely presentational:
 * the surfaces that host it own the hover copy and the click behaviour (in
 * chat, `ContextWindowDialog` supplies both).
 */
export function ContextIndicator({
  tokensUsed,
  maxTokens,
  className,
  size = "sm",
}: ContextIndicatorProps) {
  const percentage = useMemo(() => {
    if (!maxTokens || maxTokens === 0) return 0;
    return Math.min((tokensUsed / maxTokens) * 100, 100);
  }, [tokensUsed, maxTokens]);

  if (!maxTokens) {
    return null;
  }

  return (
    <ProgressRing
      percent={percentage}
      size={size}
      className={className}
      arcClassName={usageStrokeColor(percentage)}
    >
      {/* Percentage label inside ring — only for md size */}
      {size === "md" && (
        <span
          className={cn(
            "text-[8px] font-medium tabular-nums",
            usageTextColor(percentage),
          )}
        >
          {Math.round(percentage)}
        </span>
      )}
    </ProgressRing>
  );
}
