"use client";

import {
  CONTEXT_WINDOW_CATEGORIES,
  type ContextWindowBreakdown,
  type ContextWindowCategory,
  type ContextWindowItem,
  E2eTestId,
} from "@archestra/shared";
import { ChevronRight, Sparkles } from "lucide-react";
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
import { useAppName } from "@/lib/hooks/use-app-name";
import { cn } from "@/lib/utils";

// ============================================================================
// Category metadata — label, color, one-line hint in canonical stack order
// ============================================================================

interface CategoryMeta {
  label: string;
  /** Tailwind bg class for the legend dot and the stacked bar segment. */
  color: string;
  /** One-line explanation shown under the category when expanded. */
  hint: string;
}

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

// ============================================================================
// Public types
// ============================================================================

interface LastCompaction {
  originalTokenEstimate?: number;
  compactedTokenEstimate?: number;
  trigger?: "auto" | "manual";
}

interface ContextWindowDialogProps {
  breakdown: ContextWindowBreakdown | null;
  /** Live token count seeding the view before a breakdown arrives. */
  tokensUsed: number;
  maxTokens: number | null;
  /** Input tokens served from the prompt cache on the latest response. */
  cachedTokens?: number;
  lastCompaction?: LastCompaction | null;
  /** The trigger element (the circular context indicator). */
  children: ReactNode;
}

// ============================================================================
// Dialog shell
// ============================================================================

/**
 * Modal explaining how the model's context window was assembled for the
 * current turn. The trigger (children) is the ring indicator in the toolbar.
 */
export function ContextWindowDialog({
  breakdown,
  tokensUsed,
  maxTokens,
  lastCompaction,
  children,
}: ContextWindowDialogProps) {
  const appName = useAppName();

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
          <EmptyState
            tokensUsed={tokensUsed}
            maxTokens={maxTokens}
            appName={appName}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Panel — exported for standalone use in tests and other surfaces
// ============================================================================

interface ContextWindowPanelProps {
  breakdown: ContextWindowBreakdown;
  lastCompaction?: LastCompaction | null;
}

/**
 * The breakdown body: summary header, full-width stacked bar, optional
 * compaction note, scrollable category gauges, and estimate footnote.
 * Rendered inside `ContextWindowDialog` and directly in tests.
 */
export function ContextWindowPanel({
  breakdown,
  lastCompaction,
}: ContextWindowPanelProps) {
  const {
    model,
    provider,
    contextLength,
    usedTokens,
    freeTokens,
    usedPercent,
    estimatedInputCostUsd,
    segments,
  } = breakdown;

  // Denominator for bar / share math: real window when known, else used total.
  const denominator =
    contextLength != null && contextLength > 0
      ? contextLength
      : usedTokens || 1;

  const compactionSaved = resolveCompactionSavings(lastCompaction);

  // Lookup by category for the stacked bar (only present categories have tokens).
  const segmentByCategory = Object.fromEntries(
    segments.map((s) => [s.category, s]),
  );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col text-sm"
      data-testid={E2eTestId.ChatContextUsagePanel}
    >
      {/* ── Summary header — pinned ─────────────────────────────────────── */}
      <div className="shrink-0 space-y-3 px-5 py-4">
        {/* Model identity + headline percentage */}
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium" title={model}>
                {model}
              </span>
              <Badge
                variant="secondary"
                className="shrink-0 px-1.5 py-0 text-[10px] font-normal"
              >
                {provider}
              </Badge>
            </div>
            <span className="text-xs text-muted-foreground tabular-nums">
              {formatTokens(usedTokens)}
              {contextLength != null
                ? ` / ${formatTokens(contextLength)} tokens`
                : " tokens"}
              {typeof estimatedInputCostUsd === "number" &&
                ` · ${formatCost(estimatedInputCostUsd)}/turn`}
            </span>
          </div>

          {usedPercent != null && (
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

        {/* Full-width stacked composition bar */}
        <StackedBar
          categories={CONTEXT_WINDOW_CATEGORIES}
          segmentByCategory={segmentByCategory}
          freeTokens={freeTokens}
          denominator={denominator}
        />

        {/* Compaction note — only when tokens were actually freed */}
        {compactionSaved > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            <Sparkles
              className="mt-0.5 size-3.5 shrink-0 text-violet-500"
              aria-hidden
            />
            <span>
              {lastCompaction?.trigger === "manual"
                ? "Compaction"
                : "Auto-compaction"}{" "}
              summarized earlier turns and freed{" "}
              <span className="font-medium text-foreground">
                {formatTokens(compactionSaved)} tokens
              </span>{" "}
              in this conversation.
            </span>
          </div>
        )}
      </div>

      {/* ── Per-category gauges — scrolls when tall ─────────────────────── */}
      <ul
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto border-t border-border/60 px-5 py-4"
        aria-label="Context window categories"
      >
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

        {/* Free space — only when context length is known */}
        {freeTokens != null && (
          <GaugeRow
            label="Free space"
            color="bg-muted-foreground/30"
            tokens={Math.max(freeTokens, 0)}
            share={percentOf(Math.max(freeTokens, 0), denominator)}
            muted
          />
        )}
      </ul>

      {/* ── Footnote — pinned ───────────────────────────────────────────── */}
      <p className="shrink-0 border-t border-border/60 px-5 py-3 text-[11px] leading-relaxed text-muted-foreground">
        Estimated before sending, on the same yardstick that triggers
        auto-compaction. Refined with the provider's exact count after each
        response.
      </p>
    </div>
  );
}

// ============================================================================
// Stacked composition bar
// ============================================================================

function StackedBar({
  categories,
  segmentByCategory,
  freeTokens,
  denominator,
}: {
  categories: readonly ContextWindowCategory[];
  segmentByCategory: Record<string, { tokens: number } | undefined>;
  freeTokens: number | null;
  denominator: number;
}) {
  return (
    <div
      className="flex h-2.5 w-full overflow-hidden rounded-full bg-muted"
      aria-hidden
    >
      {categories.map((cat) => {
        const tokens = segmentByCategory[cat]?.tokens ?? 0;
        if (tokens <= 0) return null;
        const pct = percentOf(tokens, denominator);
        return (
          <div
            key={cat}
            className={cn("h-full shrink-0", CATEGORY_META[cat].color)}
            style={{ width: `${pct}%`, minWidth: "0.125rem" }}
            title={`${CATEGORY_META[cat].label}: ${formatTokens(tokens)}`}
          />
        );
      })}
      {/* Remaining free space: transparent, occupies the rest of the bar */}
      {freeTokens != null && freeTokens > 0 && (
        <div className="h-full flex-1 bg-transparent" />
      )}
    </div>
  );
}

// ============================================================================
// Category gauge row
// ============================================================================

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

  const header = (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {hasItems ? (
            <ChevronRight
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform duration-150",
                open && "rotate-90",
              )}
              aria-hidden
            />
          ) : (
            <span className="size-3 shrink-0" aria-hidden />
          )}
          <span
            className={cn("size-2 shrink-0 rounded-full", color)}
            aria-hidden
          />
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

      {/* Proportional fill bar + share percentage */}
      <div className="flex items-center gap-2 pl-5">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
          aria-hidden
        >
          <div
            className={cn("h-full rounded-full", color, muted && "opacity-50")}
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
    return <li>{header}</li>;
  }

  return (
    <li>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger
          className="w-full rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
          aria-expanded={open}
          aria-label={`${label}, ${formatTokens(tokens)}, expand to see top contributors`}
        >
          {header}
        </CollapsibleTrigger>
        <CollapsibleContent className="overflow-hidden data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1">
          {hint && (
            <p className="pb-1 pl-5 pt-2 text-[11px] italic text-muted-foreground">
              {hint}
            </p>
          )}
          <div className="flex flex-col gap-0.5 pl-5 pt-1">
            {items.map((item, index) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: label may repeat across categories; index is stable within this list
                key={`${item.label}-${index}`}
                className="flex items-center justify-between gap-2 py-0.5 text-xs"
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
    </li>
  );
}

// ============================================================================
// Empty / loading state
// ============================================================================

function EmptyState({
  tokensUsed,
  maxTokens,
  appName,
}: {
  tokensUsed: number;
  maxTokens: number | null;
  appName: string;
}) {
  return (
    <div className="flex flex-col gap-2 px-5 py-6 text-sm text-muted-foreground">
      {tokensUsed > 0 && maxTokens ? (
        <>
          <p className="tabular-nums">
            About{" "}
            <span className="font-medium text-foreground">
              {formatTokens(tokensUsed)}
            </span>{" "}
            of{" "}
            <span className="font-medium text-foreground">
              {formatTokens(maxTokens)}
            </span>{" "}
            tokens used.
          </p>
          <p>Send a message to see the full per-category breakdown.</p>
        </>
      ) : (
        <p>
          Send a message to see how {appName} fills the model's context window
          this turn.
        </p>
      )}
    </div>
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
  if (total <= 0) return 0;
  return Math.min((value / total) * 100, 100);
}

/** Header percentage color, escalating as the window fills. */
function usageTextColor(percent: number): string {
  if (percent >= 90) return "text-red-500";
  if (percent >= 75) return "text-orange-500";
  if (percent >= 50) return "text-yellow-500";
  return "text-emerald-500";
}

/** Compact token count: 85_600 → "85.6k", 1_000_000 → "1.0M". */
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toString();
}

/** Share percentage: one decimal under 10% so small slices stay legible. */
function formatShare(share: number): string {
  if (share > 0 && share < 10) return `${share.toFixed(1)}%`;
  return `${Math.round(share)}%`;
}

/** Per-turn input cost; sub-cent values collapse to "<$0.01". */
function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}
