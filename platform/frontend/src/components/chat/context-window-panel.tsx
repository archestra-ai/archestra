"use client";

import {
  CONTEXT_WINDOW_CATEGORIES,
  type ContextWindowBreakdown,
  type ContextWindowCategory,
  type ContextWindowItem,
  E2eTestId,
} from "@archestra/shared";
import { ChevronRight, Loader2, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { ProgressRing } from "@/components/chat/context-indicator";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  AUTO_COMPACT_PERCENT,
  autoCompactProgressPercent,
  type ContextWindowStatus,
  describeContextHeadroom,
  formatTokenCount as formatTokens,
  getContextWindowStatus,
  usageStrokeColor,
  usageTextColor,
} from "@/lib/chat/context-window-status";
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
  /**
   * Summarize earlier turns on demand. Omitted when the conversation cannot be
   * compacted (read-only, or not yet persisted), which hides the action.
   */
  onCompact?: () => void | Promise<void>;
  /** A compaction — manual or automatic — is already running. */
  isCompacting?: boolean;
  /** The trigger element (the circular context indicator). */
  children: ReactNode;
}

// ============================================================================
// Dialog shell
// ============================================================================

/**
 * Modal explaining how the model's context window was assembled for the
 * current turn. The trigger (children) is the ring indicator in the toolbar,
 * and this component owns both of its affordances: the hover tooltip that
 * summarizes headroom, and the click that opens this breakdown.
 */
export function ContextWindowDialog({
  breakdown,
  tokensUsed,
  maxTokens,
  cachedTokens,
  lastCompaction,
  onCompact,
  isCompacting = false,
  children,
}: ContextWindowDialogProps) {
  const appName = useAppName();
  // The breakdown's own percentage wins once it arrives: it is measured on the
  // same yardstick as the auto-compaction check, whereas tokensUsed/maxTokens
  // is the pre-response seed.
  const status = getContextWindowStatus(
    breakdown?.usedTokens ?? tokensUsed,
    breakdown?.contextLength ?? maxTokens,
  );

  return (
    <Dialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <DialogTrigger asChild>{children}</DialogTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-[260px]">
          <ContextUsageTooltip
            status={status}
            tokensUsed={breakdown?.usedTokens ?? tokensUsed}
            maxTokens={breakdown?.contextLength ?? maxTokens}
            cachedTokens={cachedTokens}
            isCompacting={isCompacting}
          />
        </TooltipContent>
      </Tooltip>

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
            onCompact={onCompact}
            isCompacting={isCompacting}
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
// Hover summary — the glanceable half of the indicator
// ============================================================================

/**
 * What the ring means, in three lines: how full, how much room is left before
 * the conversation gets summarized without asking, and where the click goes.
 */
function ContextUsageTooltip({
  status,
  tokensUsed,
  maxTokens,
  cachedTokens,
  isCompacting,
}: {
  status: ContextWindowStatus;
  tokensUsed: number;
  maxTokens: number | null;
  cachedTokens?: number;
  isCompacting: boolean;
}) {
  const cacheHitPercent =
    cachedTokens && cachedTokens > 0 && tokensUsed > 0
      ? Math.round((Math.min(cachedTokens, tokensUsed) / tokensUsed) * 100)
      : null;

  return (
    <div
      className="flex flex-col gap-1"
      data-testid={E2eTestId.ChatContextUsageTooltip}
    >
      <span className="font-medium">Context window</span>

      <span className="tabular-nums text-muted-foreground">
        {maxTokens != null ? (
          <span>
            {formatTokens(tokensUsed)} / {formatTokens(maxTokens)} tokens ·{" "}
            {Math.round(status.usedPercent)}% used
          </span>
        ) : (
          <span>{formatTokens(tokensUsed)} tokens used</span>
        )}
      </span>

      {isCompacting ? (
        <span className="text-muted-foreground">Compacting now…</span>
      ) : (
        // Headroom is only meaningful against a known window; without one the
        // percentages above are already suppressed and a figure here would be
        // invented.
        maxTokens != null && (
          <span
            className={cn(
              status.nearAutoCompact
                ? usageTextColor(status.usedPercent)
                : "text-muted-foreground",
            )}
          >
            {describeContextHeadroom(status)}
          </span>
        )
      )}

      {cacheHitPercent !== null && cacheHitPercent > 0 && (
        <span className="text-muted-foreground">
          {cacheHitPercent}% served from cache
        </span>
      )}

      <span className="mt-0.5 border-t border-border/60 pt-1 text-muted-foreground/70">
        Click for the full breakdown.
      </span>
    </div>
  );
}

// ============================================================================
// Panel — exported for standalone use in tests and other surfaces
// ============================================================================

interface ContextWindowPanelProps {
  breakdown: ContextWindowBreakdown;
  lastCompaction?: LastCompaction | null;
  /** Summarize earlier turns on demand; omitted when that is not possible. */
  onCompact?: () => void | Promise<void>;
  /** A compaction — manual or automatic — is already running. */
  isCompacting?: boolean;
}

/**
 * The breakdown body: summary header, full-width stacked bar, optional
 * compaction note, scrollable category gauges, and estimate footnote.
 * Rendered inside `ContextWindowDialog` and directly in tests.
 */
export function ContextWindowPanel({
  breakdown,
  lastCompaction,
  onCompact,
  isCompacting = false,
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

  // A real window is what makes headroom — and the auto-compaction tick —
  // meaningful; without one the bar is only a composition breakdown.
  const hasRealWindow = contextLength != null && contextLength > 0;
  // Denominator for bar / share math: real window when known, else used total.
  const denominator = hasRealWindow ? contextLength : usedTokens || 1;
  const status = getContextWindowStatus(usedTokens, contextLength);

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
          showAutoCompactMarker={hasRealWindow}
        />

        {/* Headroom to auto-compaction — shared verbatim with the indicator's
            hover tooltip, and marked by the tick on the bar above. Its glyph is
            the composer's own ring, filled by how far this conversation has
            travelled toward auto-compaction, so the note shows the value it is
            talking about instead of a decorative icon. Compacting is the answer
            to that sentence, so the action sits with it rather than after the
            closing footnote. */}
        {hasRealWindow && (
          <PanelNote
            icon={
              <ProgressRing
                percent={autoCompactProgressPercent(status)}
                size="xs"
                arcClassName={usageStrokeColor(status.usedPercent)}
                trackClassName="stroke-muted-foreground/25"
              />
            }
            className={cn(
              status.nearAutoCompact && usageTextColor(status.usedPercent),
            )}
            action={
              onCompact && (
                <Button
                  type="button"
                  size="sm"
                  variant={status.nearAutoCompact ? "default" : "outline"}
                  className="-my-1 shrink-0"
                  disabled={isCompacting}
                  onClick={() => void onCompact()}
                  data-testid={E2eTestId.ChatContextCompactButton}
                >
                  {isCompacting ? (
                    <>
                      <Loader2 className="animate-spin" aria-hidden />
                      <span>Compacting…</span>
                    </>
                  ) : (
                    <span>Compact now</span>
                  )}
                </Button>
              )
            }
          >
            {describeContextHeadroom(status)}
          </PanelNote>
        )}

        {/* What the last compaction actually freed — a separate event from the
            headroom above, so a separate block. */}
        {compactionSaved > 0 && (
          <PanelNote
            icon={
              <Sparkles
                className="size-3.5 shrink-0 text-violet-500"
                aria-hidden
              />
            }
          >
            {lastCompaction?.trigger === "manual"
              ? "Compaction"
              : "Auto-compaction"}{" "}
            summarized earlier turns and freed{" "}
            <span className="font-medium text-foreground">
              {formatTokens(compactionSaved)} tokens
            </span>{" "}
            in this conversation.
          </PanelNote>
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
// Summary notes
// ============================================================================

/**
 * The callout shell used by the summary header's notes. They describe separate
 * things — headroom before auto-compaction, and what the last compaction freed
 * — so each gets its own block and its own icon; sharing this shell is what
 * keeps them reading as siblings rather than two unrelated components.
 */
function PanelNote({
  icon,
  className,
  action,
  children,
}: {
  /** A 14px leading glyph — an icon, or a gauge showing the value discussed. */
  icon: ReactNode;
  className?: string;
  /** Optional trailing control, for a note whose statement has an answer. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground",
        className,
      )}
    >
      {icon}
      <span className="flex-1">{children}</span>
      {action}
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
  showAutoCompactMarker,
}: {
  categories: readonly ContextWindowCategory[];
  segmentByCategory: Record<string, { tokens: number } | undefined>;
  freeTokens: number | null;
  denominator: number;
  showAutoCompactMarker: boolean;
}) {
  return (
    <div className="relative">
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

      {/* Auto-compaction tick — only meaningful against a real window, where
          the bar's denominator is the context length rather than the total
          used so far. */}
      {showAutoCompactMarker && (
        <span
          className="absolute -top-0.5 h-3.5 w-px bg-foreground/40"
          style={{ left: `${AUTO_COMPACT_PERCENT}%` }}
          title={`Auto-compaction runs at ${AUTO_COMPACT_PERCENT}%`}
          aria-hidden
        />
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
