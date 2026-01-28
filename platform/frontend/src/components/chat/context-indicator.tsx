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
  /** Current token usage (prompt + completion tokens used so far) */
  tokensUsed: number;
  /** Maximum context window size for the model */
  maxTokens: number | null;
  /** Optional className for the container */
  className?: string;
  /** Size of the indicator */
  size?: "sm" | "md";
}

/**
 * Format token count for display (e.g., 128000 -> "128K")
 */
function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return count.toString();
}

/**
 * Get color based on usage percentage.
 * Green (0-50%), Yellow (50-75%), Orange (75-90%), Red (90%+)
 */
function getUsageColor(percentage: number): string {
  if (percentage >= 90) return "text-red-500";
  if (percentage >= 75) return "text-orange-500";
  if (percentage >= 50) return "text-yellow-500";
  return "text-emerald-500";
}

/**
 * Get stroke color for SVG based on usage percentage.
 */
function getStrokeColor(percentage: number): string {
  if (percentage >= 90) return "stroke-red-500";
  if (percentage >= 75) return "stroke-orange-500";
  if (percentage >= 50) return "stroke-yellow-500";
  return "stroke-emerald-500";
}

/**
 * Circular progress indicator showing context window usage.
 * Inspired by Vercel AI Elements Context component.
 */
export function ContextIndicator({
  tokensUsed,
  maxTokens,
  className,
  size = "sm",
}: ContextIndicatorProps) {
  const { percentage, circumference, strokeDashoffset } = useMemo(() => {
    if (!maxTokens || maxTokens === 0) {
      return { percentage: 0, circumference: 0, strokeDashoffset: 0 };
    }

    const pct = Math.min((tokensUsed / maxTokens) * 100, 100);
    // SVG circle parameters
    const radius = size === "sm" ? 8 : 10;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (pct / 100) * circ;

    return {
      percentage: pct,
      circumference: circ,
      strokeDashoffset: offset,
    };
  }, [tokensUsed, maxTokens, size]);

  // Don't render if no max tokens or no usage
  if (!maxTokens) {
    return null;
  }

  const dimensions = size === "sm" ? "size-5" : "size-6";
  const svgSize = size === "sm" ? 20 : 24;
  const radius = size === "sm" ? 8 : 10;
  const strokeWidth = size === "sm" ? 2 : 2.5;
  const center = svgSize / 2;

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "relative inline-flex items-center justify-center cursor-default",
              dimensions,
              className,
            )}
          >
            {/* Background circle */}
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
              {/* Progress */}
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
            {/* Percentage text (only show for md size) */}
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
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Context Usage</span>
            <span className="text-muted-foreground">
              {formatTokenCount(tokensUsed)} / {formatTokenCount(maxTokens)}{" "}
              tokens ({Math.round(percentage)}%)
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/**
 * Compact context badge showing tokens used / max tokens.
 * Alternative to circular indicator for inline display.
 */
export function ContextBadge({
  tokensUsed,
  maxTokens,
  className,
}: Omit<ContextIndicatorProps, "size">) {
  if (!maxTokens) {
    return null;
  }

  const percentage = Math.min((tokensUsed / maxTokens) * 100, 100);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums bg-muted/50",
              getUsageColor(percentage),
              className,
            )}
          >
            <span>{formatTokenCount(tokensUsed)}</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">
              {formatTokenCount(maxTokens)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Context Usage</span>
            <span className="text-muted-foreground">
              {tokensUsed.toLocaleString()} / {maxTokens.toLocaleString()}{" "}
              tokens
            </span>
            <span className="text-muted-foreground">
              {Math.round(percentage)}% of context window used
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
