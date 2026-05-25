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
  tokensUsed?: number;
  /** Maximum context window size for the model */
  maxTokens?: number | null;
  /** Backend-calculated model context usage. Preferred when available. */
  contextUsage?: ContextUsage | null;
  /** Configured unknown-model fallback context window from public config. */
  defaultUnknownContextWindowTokens?: number | null;
  /** Configured auto-compact threshold ratio from public config. */
  autoCompactThresholdRatio?: number | null;
  /** Optional className for the container */
  className?: string;
  /** Size of the indicator */
  size?: "sm" | "md";
}

export type ContextWindowSource =
  | "explicit_config"
  | "model_registry"
  | "provider_reported"
  | "fallback_unknown_model";

export type ContextUsageLevel = "normal" | "warning" | "danger" | "overflow";

export type ContextUsage = {
  estimatedContextTokens: number;
  effectiveContextWindowTokens: number;
  fillRatio: number;
  fillPercent: number;
  contextWindowSource: ContextWindowSource;
  isContextWindowEstimated: boolean;
  autoCompactThresholdTokens: number;
  autoCompactThresholdRatio: number;
  shouldAutoCompact: boolean;
  level: ContextUsageLevel;
  lastUpdatedAt: string;
};

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
 * Get color based on usage level.
 */
function getUsageColor(level: ContextUsageLevel): string {
  if (level === "overflow") return "text-red-500";
  if (level === "danger") return "text-orange-500";
  if (level === "warning") return "text-yellow-500";
  return "text-emerald-500";
}

/**
 * Get stroke color for SVG based on usage level.
 */
function getStrokeColor(level: ContextUsageLevel): string {
  if (level === "overflow") return "stroke-red-500";
  if (level === "danger") return "stroke-orange-500";
  if (level === "warning") return "stroke-yellow-500";
  return "stroke-emerald-500";
}

function getUsageLevel(fillRatio: number): ContextUsageLevel {
  if (fillRatio >= 1) return "overflow";
  if (fillRatio >= 0.85) return "danger";
  if (fillRatio >= 0.7) return "warning";
  return "normal";
}

function getSourceLabel(source: ContextWindowSource): string {
  switch (source) {
    case "explicit_config":
      return "explicit configuration";
    case "model_registry":
      return "model registry";
    case "provider_reported":
      return "provider reported";
    case "fallback_unknown_model":
      return "estimated context window for unknown model";
  }
}

/**
 * Circular progress indicator showing context window usage.
 * Inspired by Vercel AI Elements Context component.
 */
export function ContextIndicator({
  tokensUsed,
  maxTokens,
  contextUsage,
  defaultUnknownContextWindowTokens,
  autoCompactThresholdRatio,
  className,
  size = "sm",
}: ContextIndicatorProps) {
  const usage = useMemo(() => {
    if (contextUsage) {
      const windowTokens = contextUsage.effectiveContextWindowTokens;
      const tokens = contextUsage.estimatedContextTokens;
      const windowFillRatio = windowTokens > 0 ? tokens / windowTokens : 0;
      const thresholdTokens = contextUsage.autoCompactThresholdTokens;

      return {
        tokens,
        maxTokens: windowTokens,
        fillPercent: Math.round(windowFillRatio * 100),
        displayPercent: Math.min(Math.round(windowFillRatio * 100), 100),
        thresholdTokens,
        compactFillPercent: contextUsage.fillPercent,
        source: contextUsage.contextWindowSource,
        isEstimated: contextUsage.isContextWindowEstimated,
        level: getUsageLevel(windowFillRatio),
      };
    }

    if (typeof maxTokens === "number" && maxTokens > 0) {
      const thresholdTokens =
        typeof autoCompactThresholdRatio === "number" &&
        autoCompactThresholdRatio > 0
          ? Math.floor(maxTokens * autoCompactThresholdRatio)
          : maxTokens;
      const tokens = tokensUsed ?? 0;
      const windowFillRatio = tokens / maxTokens;
      const thresholdFillRatio = thresholdTokens ? tokens / thresholdTokens : 0;
      return {
        tokens,
        maxTokens,
        fillPercent: Math.round(windowFillRatio * 100),
        displayPercent: Math.min(Math.round(windowFillRatio * 100), 100),
        thresholdTokens,
        compactFillPercent: Math.round(thresholdFillRatio * 100),
        source: "model_registry" as ContextWindowSource,
        isEstimated: false,
        level: getUsageLevel(windowFillRatio),
      };
    }

    // Placeholder: show an empty ring immediately even before we know the
    // effective context window size.
    const placeholderMaxTokens =
      typeof defaultUnknownContextWindowTokens === "number" &&
      defaultUnknownContextWindowTokens > 0
        ? Math.floor(defaultUnknownContextWindowTokens)
        : null;
    if (!placeholderMaxTokens) {
      return null;
    }

    const thresholdTokens =
      typeof autoCompactThresholdRatio === "number" &&
      autoCompactThresholdRatio > 0
        ? Math.floor(placeholderMaxTokens * autoCompactThresholdRatio)
        : placeholderMaxTokens;
    const placeholderTokens = tokensUsed ?? 0;
    const windowFillRatio = placeholderMaxTokens
      ? placeholderTokens / placeholderMaxTokens
      : 0;
    const thresholdFillRatio = thresholdTokens
      ? placeholderTokens / thresholdTokens
      : 0;
    return {
      tokens: placeholderTokens,
      maxTokens: placeholderMaxTokens,
      fillPercent: Math.round(windowFillRatio * 100),
      displayPercent: Math.min(Math.round(windowFillRatio * 100), 100),
      thresholdTokens,
      compactFillPercent: Math.round(thresholdFillRatio * 100),
      source: "fallback_unknown_model" as ContextWindowSource,
      isEstimated: true,
      level: getUsageLevel(windowFillRatio),
    };
  }, [
    autoCompactThresholdRatio,
    contextUsage,
    defaultUnknownContextWindowTokens,
    maxTokens,
    tokensUsed,
  ]);

  if (!usage) {
    return null;
  }

  const { circumference, strokeDashoffset } = useMemo(() => {
    if (!usage?.maxTokens) {
      return { circumference: 0, strokeDashoffset: 0 };
    }

    // SVG circle parameters
    const radius = size === "sm" ? 8 : 10;
    const circ = 2 * Math.PI * radius;
    const offset = circ - (usage.displayPercent / 100) * circ;

    return {
      circumference: circ,
      strokeDashoffset: offset,
    };
  }, [usage?.maxTokens, usage?.displayPercent, size]);

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
                className="stroke-muted-foreground/30"
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
                  getStrokeColor(usage.level),
                )}
              />
            </svg>
            {/* Percentage text (only show for md size) */}
            {size === "md" && (
              <span
                className={cn(
                  "text-[8px] font-medium tabular-nums",
                  getUsageColor(usage.level),
                )}
              >
                {usage.displayPercent}
              </span>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Context {usage.fillPercent}%</span>
            <span className="text-muted-foreground">
              {formatTokenCount(usage.tokens)} / {usage.isEstimated ? "~" : ""}
              {formatTokenCount(usage.maxTokens)} tokens
            </span>
            <span className="text-muted-foreground">
              Source: {getSourceLabel(usage.source)}
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
  contextUsage,
  className,
}: Omit<ContextIndicatorProps, "size">) {
  const tokens = contextUsage?.estimatedContextTokens ?? tokensUsed;
  const windowTokens =
    contextUsage?.effectiveContextWindowTokens ?? maxTokens ?? null;

  if (!windowTokens || !tokens) {
    return null;
  }

  const fillPercent =
    contextUsage?.fillPercent ?? Math.round((tokens / windowTokens) * 100);
  const displayPercent = Math.min(fillPercent, 100);
  const level = contextUsage?.level ?? getUsageLevel(tokens / windowTokens);

  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium tabular-nums bg-muted/50",
              getUsageColor(level),
              className,
            )}
          >
            <span>Context {displayPercent}%</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-muted-foreground">
              {contextUsage?.isContextWindowEstimated ? "~" : ""}
              {formatTokenCount(windowTokens)}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="font-medium">Context Usage</span>
            <span className="text-muted-foreground">
              {tokens.toLocaleString()} / {windowTokens.toLocaleString()} tokens
            </span>
            <span className="text-muted-foreground">
              {fillPercent}% of context window used
            </span>
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
