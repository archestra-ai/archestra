"use client";

import type { SupportedProvider } from "@archestra/shared";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import {
  describeModelOrigin,
  formatCompactNumber,
  formatRequestCost,
  shortModelName,
  sourceLabel,
} from "@/app/llm/logs/_parts/logs-table-format";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { CopyButton } from "@/components/copy-button";
import { formatCost } from "@/components/cost";
import { RequestAttributionLabels } from "@/components/request-attribution-labels";
import { SourceIcon } from "@/components/source-badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import {
  BigFigure,
  GhostThread,
  OVERVIEW_GRID,
  OverviewCell,
  OverviewFact,
  OverviewHeader,
  OverviewSection,
  paneHeight,
} from "./overview-parts";
import { PoolAttempt } from "./pool-attempt";
import { RequestContent } from "./request-content";
import { KindChip } from "./request-waterfall";
import {
  type RequestSpan,
  requestLabel,
  requestPrompt,
  SPAN_KINDS,
  type TimelineSpan,
  type ToolCallSpan,
} from "./session-timeline";
import { ToolCallOverview, ToolCallPayload } from "./tool-call-details";

/**
 * The bottom of the split: the selected record's overview on the left, and on
 * the right a request's conversation, raw request and raw response, or a tool
 * call's arguments and result.
 *
 * `excerpt` is for the MCP tool call page, which shows a few records around
 * one call: its timings drop what only means something across the whole
 * session, and the call itself drops the link to the page the reader is on
 * and the outcome notice, which the page states above.
 */
export function RequestDetails({
  height,
  loading,
  span,
  origin,
  previous,
  index,
  count,
  profileName,
  providerLabel,
  serverDisplayByName,
  onStep,
  latestRequestId,
  onJumpToLatest,
  excerpt,
  toolCallChecks,
}: {
  /** The pane height, applied from `lg`. */
  height: number;
  loading: boolean;
  span: TimelineSpan | null;
  /** Epoch ms the session's axis starts at. */
  origin: number;
  /** The span before the selected one, for the idle gap before it. */
  previous: TimelineSpan | null;
  index: number;
  count: number;
  profileName: string | null;
  providerLabel: (provider: SupportedProvider) => string;
  serverDisplayByName: Map<string, McpServerDisplay>;
  onStep: (delta: number) => void;
  /** The session's latest request, whose thread is the whole conversation. */
  latestRequestId: string | null;
  onJumpToLatest: (() => void) | null;
  excerpt?: { currentKey: string };
  /** The guardrail checks a selected tool call went through. */
  toolCallChecks?: (span: ToolCallSpan) => ReactNode;
}) {
  if (!span) {
    return (
      <section
        aria-label="Request details"
        className="grid border-t lg:h-[var(--pane-h)] lg:grid-cols-[300px_minmax(0,1fr)] lg:border-t-0"
        style={paneHeight(height)}
      >
        <div className="space-y-5 bg-muted/25 p-5 lg:border-r">
          {loading ? (
            [0, 1, 2].map((i) => (
              <div key={i} className="space-y-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-6 w-28" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-4/5" />
              </div>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">
              Select a request to see its details.
            </p>
          )}
        </div>
        <div className="hidden items-center justify-center lg:flex">
          {loading ? <GhostThread /> : null}
        </div>
      </section>
    );
  }

  if (span.type === "tool") {
    const current = excerpt?.currentKey === span.key;
    return (
      <section
        aria-label="Tool call details"
        className="flex flex-col border-t lg:grid lg:h-[var(--pane-h)] lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden lg:border-t-0"
        style={paneHeight(height)}
      >
        <ToolCallOverview
          span={span}
          origin={origin}
          previous={previous}
          index={index}
          count={count}
          display={serverDisplayByName.get(span.call.mcpServerName)}
          onStep={onStep}
          timing={excerpt ? "excerpt" : "session"}
          current={current}
          checks={toolCallChecks?.(span)}
        />
        <ToolCallPayload call={span.call} outcomeNotice={!current} />
      </section>
    );
  }

  const { row } = span;
  const label = requestLabel(row, profileName);

  return (
    // Phones: the overview then the content in the page's own flow, each with a
    // sticky header. Wide: the fixed-height split.
    <section
      aria-label="Request details"
      className="flex flex-col border-t lg:grid lg:h-[var(--pane-h)] lg:grid-cols-[300px_minmax(0,1fr)] lg:overflow-hidden lg:border-t-0"
      style={paneHeight(height)}
    >
      <RequestOverview
        span={span}
        origin={origin}
        previous={previous}
        index={index}
        count={count}
        label={label}
        providerLabel={providerLabel}
        onStep={onStep}
        excerpt={Boolean(excerpt)}
      />

      <RequestContent
        span={span}
        label={label}
        profileName={profileName}
        latest={span.row.id === latestRequestId}
        onJumpToLatest={onJumpToLatest}
      />
    </section>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

function RequestOverview({
  span,
  origin,
  previous,
  index,
  count,
  label,
  providerLabel,
  onStep,
  excerpt,
}: {
  span: RequestSpan;
  /** Epoch ms the session's axis starts at. */
  origin: number;
  previous: TimelineSpan | null;
  index: number;
  count: number;
  label: string;
  providerLabel: (provider: SupportedProvider) => string;
  onStep: (delta: number) => void;
  excerpt: boolean;
}) {
  const { row, kind } = span;
  const modelOrigin = row.model
    ? describeModelOrigin({ model: row.model, interactionType: row.type })
    : null;
  const provider =
    modelOrigin && modelOrigin.kind !== "unknown" ? modelOrigin.provider : null;
  const vendor = !modelOrigin
    ? "Unknown"
    : modelOrigin.kind === "aggregator"
      ? providerLabel(modelOrigin.provider)
      : modelOrigin.name;
  const modelName = row.model ? shortModelName(row.model) : "Unknown model";
  const gapBefore = previous ? span.start - previous.end : null;
  const prompt = kind === "main" ? requestPrompt(row) : null;

  // Tokens: cache counts are part of the input when they fit inside it
  // (OpenAI-style); otherwise they are reported beside it (Anthropic-style).
  const input = row.inputTokens ?? 0;
  const output = row.outputTokens ?? 0;
  const read = row.cacheReadTokens ?? 0;
  const write = row.cacheWriteTokens ?? 0;
  const cacheInsideInput = read + write <= input;
  const fresh = cacheInsideInput ? input - read - write : input;
  const tokenTotal = cacheInsideInput
    ? input + output
    : input + read + write + output;
  const segments = [
    {
      key: "fresh",
      label: row.inputTokensEstimated ? "Fresh input (est.)" : "Fresh input",
      value: fresh,
      tone: TOKEN_TONES.fresh,
    },
    {
      key: "read",
      label: "Cache read",
      value: read,
      tone: TOKEN_TONES.cacheRead,
    },
    {
      key: "write",
      label: "Cache write",
      value: write,
      tone: TOKEN_TONES.cacheWrite,
    },
    { key: "output", label: "Output", value: output, tone: TOKEN_TONES.output },
  ];
  const cacheShare = input > 0 && cacheInsideInput ? read / input : 0;

  const cost = Number(row.cost ?? 0);
  const baseline = Number(row.baselineCost ?? row.cost ?? 0);
  const onPlan = row.billingMode === "subscription";
  const billed = onPlan ? 0 : cost;
  const saved = Math.max(0, baseline - cost);
  const rerouted = Boolean(
    row.baselineModel && row.baselineModel !== row.model,
  );

  return (
    <aside
      aria-label="Request overview"
      className="flex min-w-0 flex-col border-b bg-muted/25 lg:min-h-0 lg:border-r lg:border-b-0"
    >
      <OverviewHeader index={index} count={count} onStep={onStep} />

      <div className="divide-y divide-border/60 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        <OverviewSection>
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                "h-4 w-[3px] shrink-0 rounded-full",
                SPAN_KINDS[kind].bar,
              )}
              aria-hidden="true"
            />
            <span className="truncate text-sm font-semibold">{label}</span>
            <KindChip kind={kind} />
          </div>
          {prompt && prompt !== label ? (
            // The list names a request by what it did; this is what it was for.
            <p
              className="mt-1 line-clamp-2 pl-[11px] text-xs text-muted-foreground"
              title={prompt}
            >
              <span className="font-medium text-foreground/80">Prompt</span>{" "}
              {prompt}
            </p>
          ) : null}
          <div
            className="mt-2 flex min-w-0 items-center gap-2"
            title={row.model ?? undefined}
          >
            <MakerDisc
              provider={provider}
              vendor={vendor}
              size={20}
              ring={false}
            />
            <span className="truncate text-[13px] font-medium">
              {modelName}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {vendor}
            </span>
          </div>
          <dl className="mt-2">
            {row.source ? (
              <OverviewFact label="Source">
                <span className="inline-flex min-w-0 items-center gap-1.5 [&_svg]:size-3">
                  <SourceIcon source={row.source} />
                  <span className="truncate">{sourceLabel(row.source)}</span>
                </span>
              </OverviewFact>
            ) : null}
            <OverviewFact label="Endpoint">
              <span className="truncate font-mono text-[11px]">{row.type}</span>
            </OverviewFact>
            <OverviewFact label="Request ID">
              <span className="inline-flex min-w-0 items-center gap-0.5">
                <span className="truncate font-mono text-[11px]">{row.id}</span>
                <CopyButton text={row.id} size={11} />
              </span>
            </OverviewFact>
          </dl>
        </OverviewSection>

        <OverviewSection title="Attribution labels">
          <p className="mb-2 text-xs text-muted-foreground">
            Captured at request start. Credential labels override billing-team
            labels.
          </p>
          <RequestAttributionLabels labels={row.attributionLabels} />
        </OverviewSection>

        <OverviewSection
          title="Timing"
          aside={<BigFigure value={formatLatency(row.durationMs)} />}
        >
          {/* The list's bar already places it on the session's timeline;
              this says when, and what came before. */}
          <dl className="grid grid-cols-3 gap-x-4">
            <OverviewCell label="At">
              {formatDate({ date: row.createdAt, dateFormat: "HH:mm:ss" })}
            </OverviewCell>
            {excerpt ? null : (
              <OverviewCell label="Into session">
                +{formatElapsed(span.start - origin)}
              </OverviewCell>
            )}
            {excerpt && gapBefore == null ? null : (
              <OverviewCell label="Before it">
                {gapBefore == null
                  ? "First on page"
                  : gapBefore < 0
                    ? "Overlapped previous"
                    : `${formatElapsed(gapBefore)} idle`}
              </OverviewCell>
            )}
          </dl>
        </OverviewSection>

        <OverviewSection
          title="Tokens"
          aside={<BigFigure value={tokenTotal.toLocaleString()} />}
        >
          <div className="flex h-1.5 gap-px overflow-hidden rounded-full bg-muted">
            {segments
              .filter((segment) => segment.value > 0)
              .map((segment) => (
                <span
                  key={segment.key}
                  className={segment.tone}
                  style={{
                    width: `${(segment.value / Math.max(tokenTotal, 1)) * 100}%`,
                  }}
                />
              ))}
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {segments.map((segment) => (
              <li
                key={segment.key}
                className={cn(
                  "flex min-w-0 items-center gap-1.5",
                  segment.value === 0 && "opacity-40",
                )}
                title={
                  tokenTotal > 0
                    ? `${Math.round((segment.value / tokenTotal) * 100)}% of tokens`
                    : undefined
                }
              >
                <span
                  className={cn("size-2 shrink-0 rounded-[2px]", segment.tone)}
                  aria-hidden="true"
                />
                <span className="truncate text-muted-foreground">
                  {segment.label}
                </span>
                <span className="ml-auto tabular-nums">
                  {formatCompactNumber(segment.value)}
                </span>
              </li>
            ))}
          </ul>
          {cacheShare > 0 ? (
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              {Math.round(cacheShare * 100)}% of input from the prompt cache
            </p>
          ) : null}
          {row.inputTokensEstimated ? (
            <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
              Input is estimated from the request: the provider reported no
              usage.
            </p>
          ) : null}
        </OverviewSection>

        <PoolAttempt row={row} />

        <OverviewSection
          title="Cost"
          aside={
            <span className="flex items-center gap-1.5">
              {onPlan ? <PlanTag /> : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="cursor-default">
                    <BigFigure
                      value={formatRequestCost(billed)}
                      muted={onPlan}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent className="tabular-nums">
                  {formatCost(billed)}
                </TooltipContent>
              </Tooltip>
            </span>
          }
        >
          <dl className={OVERVIEW_GRID}>
            <OverviewCell label="Billing">
              {onPlan ? "Subscription plan" : "Metered"}
            </OverviewCell>
            <OverviewCell label="List price">
              <span title={formatCost(cost)}>{formatRequestCost(cost)}</span>
            </OverviewCell>
            <OverviewCell label="Routing">
              {rerouted && row.baselineModel ? (
                <span className="inline-flex min-w-0 items-center gap-1">
                  <span className="truncate text-muted-foreground">
                    {shortModelName(row.baselineModel)}
                  </span>
                  <ArrowRight
                    className="size-3 shrink-0 text-muted-foreground/60"
                    aria-hidden="true"
                  />
                  <span className="truncate">{modelName}</span>
                </span>
              ) : (
                <span className="text-muted-foreground">As requested</span>
              )}
            </OverviewCell>
            {saved > 0 ? (
              <OverviewCell label="Saved">
                <span
                  className="font-medium text-emerald-700 dark:text-emerald-400"
                  title={formatCost(saved)}
                >
                  {formatRequestCost(saved)}
                  {baseline > 0
                    ? ` · ${Math.round((saved / baseline) * 100)}%`
                    : ""}
                </span>
              </OverviewCell>
            ) : rerouted ? (
              <OverviewCell label="Baseline price">
                <span title={formatCost(baseline)}>
                  {formatRequestCost(baseline)}
                </span>
              </OverviewCell>
            ) : null}
          </dl>
        </OverviewSection>
      </div>
    </aside>
  );
}

/** One neutral ramp for token splits, so it never competes with kind colours. */
const TOKEN_TONES = {
  fresh: "bg-foreground/45",
  cacheRead: "bg-foreground/20",
  cacheWrite: "bg-foreground/10",
  output: "bg-foreground/80",
};

function PlanTag() {
  return (
    <span className="rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium tracking-wide text-muted-foreground uppercase">
      Plan
    </span>
  );
}
