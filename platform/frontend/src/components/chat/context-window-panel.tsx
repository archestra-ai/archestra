"use client";

import {
  type ContextWindowBreakdown,
  type ContextWindowCategory,
  type ContextWindowItem,
  E2eTestId,
} from "@shared";
import { ChevronDown, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface CategoryMeta {
  label: string;
  /** Tailwind background for the legend dot and the stacked bar segment. */
  color: string;
  /** One-line explanation shown under the category when expanded. */
  hint: string;
}

/** Display order + styling + copy for each context-window category. */
const CATEGORY_META: Record<ContextWindowCategory, CategoryMeta> = {
  system_prompt: {
    label: "System prompt",
    color: "bg-amber-500",
    hint: "The agent's instructions, sent on every turn.",
  },
  tools: {
    label: "Tools",
    color: "bg-sky-500",
    hint: "Schemas for the tools this agent can call.",
  },
  messages: {
    label: "Messages",
    color: "bg-violet-500",
    hint: "The conversation history (your turns and the assistant's).",
  },
  tool_results: {
    label: "Tool results",
    color: "bg-emerald-500",
    hint: "Output returned from tool and knowledge-base calls.",
  },
  files: {
    label: "Files",
    color: "bg-rose-500",
    hint: "Attachments included in the conversation.",
  },
};

interface LastCompaction {
  originalTokenEstimate?: number;
  compactedTokenEstimate?: number;
  trigger?: "auto" | "manual";
}

interface ContextWindowDialogProps {
  breakdown: ContextWindowBreakdown | null;
  /** Live token usage for the fallback view before a breakdown arrives. */
  tokensUsed: number;
  maxTokens: number | null;
  lastCompaction?: LastCompaction | null;
  /** The trigger element (the circular context indicator). */
  children: ReactNode;
}

/**
 * Modal that explains how the model's context window was assembled for the
 * current turn — a stacked bar plus an expandable per-category breakdown with
 * the largest individual contributors, a compaction marker, and an estimated
 * per-turn cost.
 */
export function ContextWindowDialog({
  breakdown,
  tokensUsed,
  maxTokens,
  lastCompaction,
  children,
}: ContextWindowDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="shrink-0 space-y-1 border-b border-border/60 px-5 pb-3 pt-5 text-left">
          <DialogTitle className="text-base">Context window</DialogTitle>
          <DialogDescription className="text-xs">
            What's filling the model's context this turn.
          </DialogDescription>
        </DialogHeader>
        {breakdown ? (
          <ContextWindowPanel
            breakdown={breakdown}
            lastCompaction={lastCompaction}
          />
        ) : (
          <div className="px-5 py-6 text-sm text-muted-foreground">
            {maxTokens
              ? `About ${formatTokens(tokensUsed)} of ${formatTokens(maxTokens)} tokens used. Send a message to see the full breakdown.`
              : "Send a message to see how this conversation fills the model's context window."}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ContextWindowPanelProps {
  breakdown: ContextWindowBreakdown;
  lastCompaction?: LastCompaction | null;
}

/**
 * The breakdown body: summary header, stacked bar, optional compaction marker,
 * and the expandable category table. Rendered inside ContextWindowDialog (and
 * standalone in tests).
 */
export function ContextWindowPanel({
  breakdown,
  lastCompaction,
}: ContextWindowPanelProps) {
  const {
    contextLength,
    usedTokens,
    freeTokens,
    usedPercent,
    estimatedInputCostUsd,
    segments,
  } = breakdown;

  // Bar/percent denominators: against the real window when known, otherwise
  // against the used total so the bar still reads as relative proportions.
  const denominator =
    contextLength && contextLength > 0 ? contextLength : usedTokens || 1;

  const compactionSaved = resolveCompactionSavings(lastCompaction);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-sm"
      data-testid={E2eTestId.ChatContextUsagePanel}
    >
      {/* Summary — pinned above the scrolling list */}
      <div className="shrink-0 space-y-3 px-5 py-4">
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium" title={breakdown.model}>
                {breakdown.model}
              </span>
              <Badge
                variant="secondary"
                className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
              >
                {breakdown.provider}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatTokens(usedTokens)}
              {contextLength
                ? ` / ${formatTokens(contextLength)} tokens`
                : " tokens"}
              {typeof estimatedInputCostUsd === "number" &&
                ` · ${formatCost(estimatedInputCostUsd)}/turn`}
            </span>
          </div>
          {usedPercent !== null && (
            <div className="flex shrink-0 flex-col items-end">
              <div className="flex items-baseline gap-0.5">
                <span
                  className={cn(
                    "text-3xl font-semibold leading-none tabular-nums",
                    usageTextColor(usedPercent),
                  )}
                >
                  {Math.round(usedPercent)}
                </span>
                <span className="text-sm text-muted-foreground">%</span>
              </div>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                used
              </span>
            </div>
          )}
        </div>

        {compactionSaved > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Sparkles className="mt-0.5 size-3.5 shrink-0 text-violet-500" />
            <span>
              Auto-compaction summarized earlier turns and freed{" "}
              <span className="font-medium text-foreground">
                {formatTokens(compactionSaved)} tokens
              </span>{" "}
              in this conversation.
            </span>
          </div>
        )}
      </div>

      {/* Per-category gauges — scrolls when tall */}
      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto border-t border-border/60 px-5 py-4">
        {segments.map((segment) => (
          <GaugeRow
            key={segment.category}
            label={CATEGORY_META[segment.category].label}
            color={CATEGORY_META[segment.category].color}
            hint={CATEGORY_META[segment.category].hint}
            tokens={segment.tokens}
            share={percentOf(segment.tokens, denominator)}
            items={segment.items}
          />
        ))}
        {freeTokens !== null && (
          <GaugeRow
            label="Free space"
            color="bg-muted-foreground/30"
            tokens={freeTokens}
            share={percentOf(freeTokens, denominator)}
            muted
          />
        )}
      </div>

      {/* Footnote — pinned below the scrolling list */}
      <p className="shrink-0 border-t border-border/60 px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Estimated before sending, on the same yardstick that triggers
        auto-compaction. Refined with the provider's exact count after each
        response.
      </p>
    </div>
  );
}

// ============================================================================
// Internal components
// ============================================================================

/**
 * One category rendered as a labeled horizontal gauge: the label + token count
 * sit on top, a proportional fill bar + share sit below. Categories that carry
 * per-item detail (e.g. Tools) expand on click into the largest contributors.
 */
function GaugeRow({
  label,
  color,
  hint,
  tokens,
  share,
  items,
  muted = false,
}: {
  label: string;
  color: string;
  hint?: string;
  tokens: number;
  share: number;
  items?: ContextWindowItem[];
  muted?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasItems = !!items && items.length > 0;

  const gauge = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {hasItems ? (
            <ChevronDown
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                !open && "-rotate-90",
              )}
            />
          ) : (
            <span className="size-3 shrink-0" aria-hidden />
          )}
          <span className={cn("size-2 shrink-0 rounded-full", color)} />
          <span className={cn("truncate", muted && "text-muted-foreground")}>
            {label}
          </span>
        </div>
        <span
          className={cn(
            "shrink-0 tabular-nums",
            muted ? "text-muted-foreground" : "font-medium",
          )}
        >
          {formatTokens(tokens)}
        </span>
      </div>
      <div className="flex items-center gap-2 pl-5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full transition-[width]", color)}
            style={{
              width: `${share}%`,
              minWidth: tokens > 0 ? "0.25rem" : undefined,
            }}
          />
        </div>
        <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
          {formatShare(share)}
        </span>
      </div>
    </div>
  );

  if (!hasItems) {
    return gauge;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="w-full text-left">
        {gauge}
      </CollapsibleTrigger>
      <CollapsibleContent className="overflow-hidden text-sm data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 data-[state=closed]:animate-out data-[state=open]:animate-in">
        {hint && (
          <p className="pb-1 pl-5 pt-2 text-[11px] text-muted-foreground">
            {hint}
          </p>
        )}
        <div className="flex flex-col gap-0.5 pl-5">
          {items.map((item, index) => (
            <div
              key={`${item.label}-${index}`}
              className="flex items-center justify-between gap-2 text-xs"
            >
              <span
                className="truncate text-muted-foreground"
                title={item.label}
              >
                {item.label}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTokens(item.tokens)}
              </span>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function resolveCompactionSavings(
  compaction: LastCompaction | null | undefined,
): number {
  if (
    !compaction ||
    typeof compaction.originalTokenEstimate !== "number" ||
    typeof compaction.compactedTokenEstimate !== "number"
  ) {
    return 0;
  }
  return Math.max(
    compaction.originalTokenEstimate - compaction.compactedTokenEstimate,
    0,
  );
}

function percentOf(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min((value / total) * 100, 100);
}

/** Header percentage color, escalating as the window fills up. */
function usageTextColor(percent: number): string {
  if (percent >= 90) return "text-red-500";
  if (percent >= 75) return "text-orange-500";
  if (percent >= 50) return "text-yellow-500";
  return "text-emerald-500";
}

/** Compact token count, e.g. 85_600 -> "85.6k", 1_000_000 -> "1.0M". */
function formatTokens(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return count.toString();
}

/** Share as a percentage; one decimal under 10% so small slices stay legible. */
function formatShare(share: number): string {
  if (share > 0 && share < 10) {
    return `${share.toFixed(1)}%`;
  }
  return `${Math.round(share)}%`;
}

/** Per-turn input cost; sub-cent values collapse to "<$0.01". */
function formatCost(usd: number): string {
  if (usd <= 0) {
    return "$0";
  }
  if (usd < 0.01) {
    return "<$0.01";
  }
  return `$${usd.toFixed(2)}`;
}
