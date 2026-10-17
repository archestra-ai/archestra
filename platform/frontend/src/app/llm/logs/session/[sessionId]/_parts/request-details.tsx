"use client";

import type { SupportedProvider } from "@archestra/shared";
import {
  ArrowRight,
  ArrowUpRight,
  MessageSquareText,
  TriangleAlert,
} from "lucide-react";
import type { ComponentProps } from "react";
import {
  describeModelOrigin,
  formatRequestCost,
  shortModelName,
  sourceLabel,
} from "@/app/llm/logs/_parts/logs-table-format";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { CopyButton } from "@/components/copy-button";
import { formatCost } from "@/components/cost";
import { PaneHeader } from "@/components/log-detail/pane-header";
import MessageThread from "@/components/message-thread";
import { SourceIcon } from "@/components/source-badge";
import { Button } from "@/components/ui/button";
import { InlineNotice, InlineNoticeText } from "@/components/ui/inline-notice";
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
  OverviewFact,
  OverviewHeader,
  OverviewSection,
  paneHeight,
} from "./overview-parts";
import { KindChip } from "./request-waterfall";
import {
  type RequestSpan,
  requestLabel,
  SPAN_KINDS,
  type TimelineSpan,
} from "./session-timeline";
import { ToolCallOverview, ToolCallPayload } from "./tool-call-details";

type ThreadProps = ComponentProps<typeof MessageThread>;

export type LoadedConversation = {
  messages: ThreadProps["messages"];
  chatErrors: ThreadProps["chatErrors"];
  conversationId: string | undefined;
  agentName: string | undefined;
  modelName: string | undefined;
};

/**
 * The bottom of the split, with no tabs: the selected request's overview on
 * the left and the conversation on the right. Only the latest request's
 * conversation is loaded, so for any other request the right column says so
 * and offers a way to it.
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
  onOpen,
  conversation,
  hasConversation,
  onJumpToConversation,
  excerpt,
}: {
  /** The resizable pane height, applied from `lg`. */
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
  onOpen: (span: TimelineSpan) => void;
  /** The latest request's conversation, when one was captured. */
  conversation: LoadedConversation | null;
  /** Whether the selected request is the one `conversation` came from. */
  hasConversation: boolean;
  onJumpToConversation: (() => void) | null;
  excerpt?: { currentKey: string };
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
          {...(current && {
            current: true,
            previews: false,
            footer: null,
          })}
        />
        <ToolCallPayload call={span.call} outcomeNotice={!current} />
      </section>
    );
  }

  const { row, kind } = span;
  const label = requestLabel(row, profileName);
  const time = formatDate({ date: row.createdAt, dateFormat: "HH:mm:ss" });

  return (
    // Phones: Overview then Conversation in the page's own flow, each with a
    // sticky header. Wide: the fixed-height, resizable split.
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
        onOpen={() => onOpen(span)}
        excerpt={Boolean(excerpt)}
      />

      <section
        aria-label="Conversation"
        className="flex min-h-[320px] min-w-0 flex-col lg:min-h-0"
      >
        <PaneHeader>
          <MessageSquareText
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="shrink-0 text-xs font-medium">Conversation</span>
          {hasConversation ? (
            <>
              <span className="ml-1 inline-flex min-w-0 items-center gap-1.5 rounded-sm bg-muted px-1.5 text-[11px] leading-5 text-muted-foreground">
                <span
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    SPAN_KINDS[kind].bar,
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 truncate font-medium text-foreground">
                  {label}
                </span>
                {/* Phones drop the time, so the name is what the room goes to. */}
                <span className="shrink-0 tabular-nums max-sm:hidden">
                  · {time}
                </span>
              </span>
              {/* An excerpt loads whichever request is picked. */}
              {excerpt ? null : (
                <span className="ml-auto inline-flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground max-sm:hidden">
                  <span
                    className="size-1.5 rounded-full bg-primary"
                    aria-hidden="true"
                  />
                  <span>Latest request</span>
                </span>
              )}
            </>
          ) : (
            <span className="ml-1 truncate text-[11px] text-muted-foreground">
              Not loaded for this request
            </span>
          )}
        </PaneHeader>
        <div className="lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
          {hasConversation && conversation ? (
            <>
              {kind === "auxiliary" ? (
                <div className="px-4 pt-3">
                  <InlineNotice variant="warning">
                    <TriangleAlert />
                    <InlineNoticeText>
                      This was a side request ({label}), so this is its prompt,
                      not the main chat thread.
                    </InlineNoticeText>
                  </InlineNotice>
                </div>
              ) : null}
              <MessageThread
                messages={conversation.messages}
                chatErrors={conversation.chatErrors}
                conversationId={conversation.conversationId}
                containerClassName="h-auto"
                hideDivider
                agentName={conversation.agentName}
                selectedModel={conversation.modelName}
              />
            </>
          ) : (
            <ConversationEmpty
              captured={Boolean(conversation)}
              label={label}
              time={time}
              onOpen={() => onOpen(span)}
              onJumpToLatest={onJumpToConversation}
            />
          )}
        </div>
      </section>
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
  onOpen,
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
  onOpen: () => void;
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
      label: "Fresh input",
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
          <div className="mt-3 flex min-w-0 items-center gap-2.5">
            <MakerDisc
              provider={provider}
              vendor={vendor}
              size={32}
              ring={false}
            />
            <span className="min-w-0">
              <span className="block truncate text-sm leading-5 font-medium">
                {modelName}
              </span>
              <span
                className="block truncate font-mono text-[11px] leading-4 text-muted-foreground"
                title={row.model ?? undefined}
              >
                {vendor} · {row.model ?? "—"}
              </span>
            </span>
          </div>
          <dl className="mt-3">
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

        <OverviewSection
          title="Timing"
          aside={<BigFigure value={formatLatency(row.durationMs)} />}
        >
          <div
            className="relative h-1 rounded-full bg-muted"
            aria-hidden="true"
          >
            <span
              className={cn(
                "absolute inset-y-0 rounded-full",
                SPAN_KINDS[kind].bar,
              )}
              style={{
                left: `${span.x * 100}%`,
                width: `max(4px, ${span.w * 100}%)`,
              }}
            />
          </div>
          <dl className="mt-2.5">
            <OverviewFact label="Started">
              {formatDate({
                date: new Date(span.start).toISOString(),
                dateFormat: "HH:mm:ss.SSS",
              })}
            </OverviewFact>
            <OverviewFact label="Finished">
              {formatDate({ date: row.createdAt, dateFormat: "HH:mm:ss.SSS" })}
            </OverviewFact>
            {excerpt ? null : (
              <OverviewFact label="Into session">
                +{formatElapsed(span.start - origin)}
              </OverviewFact>
            )}
            {excerpt && gapBefore == null ? null : (
              <OverviewFact label="Before it">
                {gapBefore == null
                  ? "First on page"
                  : gapBefore < 0
                    ? "Overlapped previous"
                    : `${formatElapsed(gapBefore)} idle`}
              </OverviewFact>
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
          <ul className="mt-2.5 space-y-[3px] text-xs">
            {segments.map((segment) => (
              <li
                key={segment.key}
                className={cn(
                  "flex items-center gap-2",
                  segment.value === 0 && "opacity-40",
                )}
              >
                <span
                  className={cn("size-2 shrink-0 rounded-[2px]", segment.tone)}
                  aria-hidden="true"
                />
                <span className="text-muted-foreground">{segment.label}</span>
                <span className="ml-auto tabular-nums">
                  {segment.value.toLocaleString()}
                </span>
                <span className="w-8 text-right text-[11px] text-muted-foreground/70 tabular-nums">
                  {tokenTotal > 0
                    ? `${Math.round((segment.value / tokenTotal) * 100)}%`
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
          {cacheShare > 0 ? (
            <p className="mt-2.5 text-[11px] leading-snug text-muted-foreground">
              {Math.round(cacheShare * 100)}% of the input came from the prompt
              cache.
            </p>
          ) : null}
        </OverviewSection>

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
          <dl>
            <OverviewFact label="Billing">
              {onPlan ? "Subscription plan" : "Metered"}
            </OverviewFact>
            <OverviewFact label="List price">
              <span title={formatCost(cost)}>{formatRequestCost(cost)}</span>
            </OverviewFact>
            {onPlan ? (
              <OverviewFact label="Covered by plan">
                <span title={formatCost(cost)}>{formatRequestCost(cost)}</span>
              </OverviewFact>
            ) : null}
            <OverviewFact label="Routing">
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
            </OverviewFact>
            {rerouted ? (
              <OverviewFact label="Baseline price">
                <span title={formatCost(baseline)}>
                  {formatRequestCost(baseline)}
                </span>
              </OverviewFact>
            ) : null}
            {saved > 0 ? (
              <OverviewFact label="Saved">
                <span
                  className="font-medium text-emerald-700 dark:text-emerald-400"
                  title={formatCost(saved)}
                >
                  {formatRequestCost(saved)}
                  {baseline > 0
                    ? ` · ${Math.round((saved / baseline) * 100)}%`
                    : ""}
                </span>
              </OverviewFact>
            ) : null}
          </dl>
        </OverviewSection>
      </div>

      {/* In flow at the end of the overview on phones; pinned under the
          column's own scroller from `lg`. It never covers content. */}
      <div className="border-t bg-card/70 p-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full justify-between"
          onClick={onOpen}
        >
          <span>Open full request</span>
          <ArrowUpRight />
        </Button>
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

function ConversationEmpty({
  captured,
  label,
  time,
  onOpen,
  onJumpToLatest,
}: {
  captured: boolean;
  label: string;
  time: string;
  onOpen: () => void;
  onJumpToLatest: (() => void) | null;
}) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 py-10 text-center">
      <GhostThread />
      <div className="mt-5 space-y-1.5">
        <p className="text-sm font-medium">
          {captured
            ? "Only the latest request's conversation is loaded"
            : "No conversation was captured for this session"}
        </p>
        {captured ? (
          <p className="mx-auto max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
            This is <span className="text-foreground">{label}</span> at{" "}
            <span className="tabular-nums">{time}</span>. Open it to read the
            exact prompt it sent and the response it got, or jump to the latest
            request to read the conversation here.
          </p>
        ) : (
          <p className="mx-auto max-w-[52ch] text-xs leading-relaxed text-muted-foreground">
            Open the request to see the payload that was recorded for it.
          </p>
        )}
      </div>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        <Button size="sm" onClick={onOpen}>
          <span>Open full request</span>
          <ArrowRight />
        </Button>
        {captured && onJumpToLatest ? (
          <Button size="sm" variant="outline" onClick={onJumpToLatest}>
            <MessageSquareText />
            <span>Jump to latest conversation</span>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** A faint, fading sketch of a thread: "messages go here" without words. */
function GhostThread() {
  return (
    <div
      aria-hidden="true"
      className="flex w-64 flex-col gap-2 [mask-image:linear-gradient(to_bottom,black_20%,transparent)]"
    >
      {GHOST_BUBBLES.map((bubble) => (
        <div
          key={bubble.key}
          className={cn(
            "flex items-end gap-2",
            bubble.side === "end" ? "flex-row-reverse" : "flex-row",
          )}
        >
          {bubble.side === "start" ? (
            <span className="size-5 shrink-0 rounded-full border border-dashed border-muted-foreground/30" />
          ) : null}
          <span
            className={cn(
              "rounded-xl border border-dashed border-muted-foreground/30",
              bubble.size,
              bubble.side === "end"
                ? "rounded-br-sm bg-muted/60"
                : "rounded-bl-sm bg-transparent",
            )}
          />
        </div>
      ))}
    </div>
  );
}

const GHOST_BUBBLES = [
  { key: "a", side: "end", size: "h-6 w-36" },
  { key: "b", side: "start", size: "h-10 w-52" },
  { key: "c", side: "end", size: "h-6 w-28" },
] as const;
