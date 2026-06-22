"use client";

import { useMemo } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ContextIndicatorProps {
  /** Current prompt-token estimate or provider count. */
  tokensUsed: number;
  /** Maximum context window size for the model. */
  maxTokens: number | null;
  /** Input tokens served from the prompt cache on the latest response, a subset of tokensUsed. */
  cachedTokens?: number;
  /** Optional className for the container */
  className?: string;
  /** Size of the indicator. */
  size?: "sm" | "md";
  /**
   * Hide the built-in hover tooltip. Set when the indicator is a trigger for a
   * richer surface (e.g. the Context Window dialog) that already explains it.
   * The ring will also use `cursor-pointer` instead of `cursor-default` in that
   * case so it signals its clickability without text.
   */
  hideTooltip?: boolean;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toString();
}

function getUsageColor(percentage: number): string {
  if (percentage >= 90) return "text-red-500";
  if (percentage >= 75) return "text-orange-500";
  if (percentage >= 50) return "text-yellow-500";
  return "text-emerald-500";
}

function getStrokeColor(percentage: number): string {
  if (percentage >= 90) return "stroke-red-500";
  if (percentage >= 75) return "stroke-orange-500";
  if (percentage >= 50) return "stroke-yellow-500";
  return "stroke-emerald-500";
}

/**
 * Circular progress indicator showing context window usage.
 * Used as the trigger for the Context Window dialog in the chat toolbar.
 */
export function ContextIndicator({
  tokensUsed,
  maxTokens,
  cachedTokens,
  className,
  size = "sm",
  hideTooltip = false,
}: ContextIndicatorProps) {
  const cacheHitPercent =
    cachedTokens && cachedTokens > 0 && tokensUsed > 0
      ? Math.round((Math.min(cachedTokens, tokensUsed) / tokensUsed) * 100)
      : null;
  const { percentage, circumference, strokeDashoffset } = useMemo(() => {
    if (!maxTokens || maxTokens === 0) {
      return { percentage: 0, circumference: 0, strokeDashoffset: 0 };
    }

    const pct = Math.min((tokensUsed / maxTokens) * 100, 100);
    const radius = size === "sm" ? 8 : 10;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (pct / 100) * circ;

    return { percentage: pct, circumference: circ, strokeDashoffset: offset };
  }, [tokensUsed, maxTokens, size]);

  if (!maxTokens) {
    return null;
  }

  const dimensions = size === "sm" ? "size-5" : "size-6";
  const svgSize = size === "sm" ? 20 : 24;
  const radius = size === "sm" ? 8 : 10;
  const strokeWidth = size === "sm" ? 2 : 2.5;
  const center = svgSize / 2;

  const ring = (
    <div
      className={cn(
        "relative inline-flex items-center justify-center",
        // When the tooltip is hidden the ring is a dialog trigger — show pointer
        // cursor so sighted users know it's clickable.
        hideTooltip ? "cursor-pointer" : "cursor-default",
        dimensions,
        className,
      )}
    >
      <svg
        className="absolute inset-0 -rotate-90"
        width={svgSize}
        height={svgSize}
        viewBox={`0 0 ${svgSize} ${svgSize}`}
        aria-hidden="true"
      >
        {/* Track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          className="stroke-muted"
        />
        {/* Progress arc */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          className={cn(
            "transition-all duration-300",
            getStrokeColor(percentage),
          )}
        />
      </svg>
      {/* Percentage label inside ring — only for md size */}
      {size === "md" && (
        <span
          className={cn(
            "text-[8px] font-medium tabular-nums",
            getUsageColor(percentage),
          )}
        >
          {Math.round(percentage)}
        </span>
      )}
    </div>
  );

  if (hideTooltip) {
    return ring;
  }

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{ring}</TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Context usage</span>
            <span className="tabular-nums text-muted-foreground">
              {formatTokenCount(tokensUsed)} / {formatTokenCount(maxTokens)}{" "}
              tokens ({Math.round(percentage)}%)
            </span>
            {cacheHitPercent !== null && cacheHitPercent > 0 && (
              <span className="text-muted-foreground">
                {cacheHitPercent}% served from cache
              </span>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
