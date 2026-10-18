"use client";
// design-arena: do not commit
import {
  ArrowRight,
  CircleAlert,
  Clock,
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
  ShieldX,
  UserCheck,
} from "lucide-react";
import {
  AUDIENCE_TONE,
  type Audience,
  CONSULT_KIND,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
  type Trust,
} from "./guardrails-mock";
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  describeModelOrigin,
  formatCompactNumber,
  formatRequestCost,
  formatUsageCost,
  shortModelName,
} from "@/app/llm/logs/_parts/logs-table-format";
import { MakerDisc } from "@/app/llm/logs/_parts/maker-disc";
import { McpCatalogIcon } from "@/components/mcp-catalog-icon";
import { McpToolCallStatusIcon } from "@/components/mcp-tool-call-status";
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import {
  MCP_TOOL_CALL_STATUS_LABELS,
  readMcpToolCall,
} from "@/lib/mcp-logs/tool-call-content";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import {
  type RequestSpan,
  requestLabel,
  SPAN_KINDS,
  type SpanKind,
  type Timeline,
  type TimelineSpan,
  type ToolCallSpan,
} from "../session-timeline";
import { StatusBarPagination } from "../status-bar-pagination";

export type RequestsPagination = {
  pageIndex: number;
  pageSize: number;
  offset: number;
  total: number;
  onPaginationChange: (pagination: {
    pageIndex: number;
    pageSize: number;
  }) => void;
};

/**
 * The top of the split: a dense, DevTools-style list of the page's requests
 * and the MCP tool calls they issued, on one shared time axis, with idle
 * stretches folded, the selection marked on the axis, and a status bar with
 * this page's totals and the pagination.
 *
 * The MCP tool call page reuses it for a short excerpt around one call: it
 * names the card, replaces the status bar, and keeps the page where it is.
 * When every row is a tool call there are no model, token or cost figures to
 * show, so the columns become server and duration instead.
 */
export function RequestWaterfall({
  timeline,
  loading,
  profileName,
  serverDisplayByName,
  conversationRowId,
  selectedKey,
  highlightedKey,
  onSelect,
  onOpen,
  openHint = "Enter or double-click to open",
  pagination,
  totalRequests,
  notice,
  action,
  title = "Requests",
  countLabel,
  hideEmptyKinds = false,
  status,
  emptyMessage = "No requests recorded for this session yet.",
  revealHighlighted = true,
  guardrails = null,
}: {
  /** Mock OpenAPPA consults + label timeline (arena only). */
  guardrails?: GuardrailsData | null;
  timeline: Timeline | null;
  loading: boolean;
  profileName: string | null;
  /** Catalog names and icons for the servers tool calls went to. */
  serverDisplayByName: Map<string, McpServerDisplay>;
  /** The latest request, whose thread is the whole conversation, marked in its row. */
  conversationRowId: string | null;
  selectedKey: string | null;
  /**
   * A span the URL pointed at: ringed so it stands out, and scrolled into
   * the page's view once on arrival.
   */
  highlightedKey: string | null;
  onSelect: (key: string) => void;
  /** Enter or a double-click on a row; `openHint` says what it opens. */
  onOpen: (span: TimelineSpan) => void;
  openHint?: string;
  pagination: RequestsPagination | null;
  totalRequests: number;
  /** Shown between the header and the list, such as a failed load. */
  notice?: ReactNode;
  /** The card's own control (Export JSON), placed beside the title. */
  action: ReactNode;
  title?: string;
  /** Replaces the "1–50 of 203" beside the title. */
  countLabel?: string;
  /** List only the kinds present, for an excerpt too short to need the key. */
  hideEmptyKinds?: boolean;
  /** Replaces the status bar's totals and paging. */
  status?: ReactNode;
  emptyMessage?: string;
  /**
   * Scroll the page to the highlighted row once it appears. Off where the
   * list sits mid-page and moving the page would pull the reader away.
   */
  revealHighlighted?: boolean;
}) {
  const spans = timeline?.spans ?? [];
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selected = spans.find((span) => span.key === selectedKey) ?? null;
  const layout: Layout =
    spans.length > 0 && spans.every((span) => span.type === "tool")
      ? "tools"
      : "trace";
  const grid = GRIDS[layout];

  const kindCounts = useMemo(() => {
    const counts: Record<SpanKind, number> = {
      main: 0,
      subagent: 0,
      auxiliary: 0,
      tool: 0,
    };
    for (const span of spans) counts[span.kind]++;
    return counts;
  }, [spans]);

  const pageTotals = useMemo(() => {
    let tokens = 0;
    let billed = 0;
    for (const span of spans) {
      if (span.type !== "request") continue;
      const { row } = span;
      tokens += (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
      billed += row.billingMode === "subscription" ? 0 : Number(row.cost ?? 0);
    }
    return { tokens, billed };
  }, [spans]);

  // Guardrail consults and label changes, woven into the rows by time. Spans
  // are already ordered by start; a stable sort keeps their order.
  const entries = useMemo<Entry[]>(() => {
    const base: Entry[] = spans.map((span) => ({
      type: "span",
      t: span.start,
      span,
    }));
    if (!guardrails) return base;
    const extra: Entry[] = [
      ...guardrails.consults.map(
        (consult): Entry => ({ type: "consult", t: consult.start, consult }),
      ),
      ...guardrails.labels.slice(1).map(
        (segment, index): Entry => ({
          type: "label",
          t: segment.start,
          segment,
          previous: guardrails.labels[index],
        }),
      ),
    ];
    return [...base, ...extra].sort((a, b) => a.t - b.t);
  }, [spans, guardrails]);

  const guardSummary = useMemo(() => {
    if (!guardrails || guardrails.labels.length === 0) return null;
    const final = guardrails.labels[guardrails.labels.length - 1];
    return {
      consults: guardrails.consults.length,
      blocked: guardrails.consults.filter((c) => c.decision === "blocked")
        .length,
      changes: guardrails.labels.length - 1,
      final,
    };
  }, [guardrails]);
  const shownLabel =
    guardrails && selected
      ? guardrails.labelAt(selected.start)
      : (guardSummary?.final ?? null);

  // Keep the selection in view inside the list when it changes from outside
  // it (the details pane's stepper, a page change landing on a new default,
  // a link to one tool call). Only the list scrolls: moving the page would
  // yank a reader who is looking at the details pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = selectedKey ? rowRefs.current.get(selectedKey) : undefined;
    if (scroller && row) scrollWithin(scroller, row);
  }, [selectedKey]);

  const revealedKey = useRef<string | null>(null);
  useEffect(() => {
    if (
      !revealHighlighted ||
      !highlightedKey ||
      revealedKey.current === highlightedKey
    )
      return;
    const row = rowRefs.current.get(highlightedKey);
    if (!row) return;
    revealedKey.current = highlightedKey;
    row.scrollIntoView?.({ block: "center" });
  });

  const moveTo = (index: number) => {
    const target = spans[index];
    if (!target) return;
    onSelect(target.key);
    rowRefs.current.get(target.key)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const current = spans.findIndex((span) => span.key === selectedKey);
    const targets: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      Home: 0,
      End: spans.length - 1,
    };
    if (event.key === "Enter" && selected) {
      event.preventDefault();
      onOpen(selected);
      return;
    }
    if (!(event.key in targets)) return;
    event.preventDefault();
    moveTo(Math.min(spans.length - 1, Math.max(0, targets[event.key])));
  };

  // Keep tick labels clear of the idle-break pills in the axis.
  const ticks = (timeline?.ticks ?? []).filter(
    (tick) =>
      !(timeline?.breaks ?? []).some(
        (b) => Math.abs(tick.x - (b.x + b.w / 2)) < 0.075,
      ),
  );

  return (
    <div>
      {/* Phones: the title, the count and the action on one line, the
          legend on one line below. Wide: one row, the legend and the action
          at the right end. */}
      <header className="flex flex-col gap-1.5 border-b px-4 py-2.5 lg:flex-row lg:items-center lg:gap-x-6">
        <div className="flex min-w-0 items-center gap-2 lg:contents">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 lg:flex-none">
            <h2 className="shrink-0 text-sm font-semibold">{title}</h2>
            <span className="truncate text-xs text-muted-foreground tabular-nums">
              {countLabel ??
                (pagination
                  ? `${(pagination.offset + 1).toLocaleString()}–${Math.min(
                      pagination.offset + pagination.pageSize,
                      pagination.total,
                    ).toLocaleString()} of ${pagination.total.toLocaleString()}`
                  : `${totalRequests.toLocaleString()} total`)}
            </span>
          </div>
          {action ? (
            <div className="-my-1 shrink-0 lg:order-last">{action}</div>
          ) : null}
        </div>
        <div className="flex min-w-0 items-center gap-x-5 lg:ml-auto">
          {guardSummary && shownLabel && guardrails ? (
            <LabelBadge
              trust={shownLabel.trust}
              audience={shownLabel.audience}
              atSelection={Boolean(selected)}
              labels={guardrails.labels}
            />
          ) : null}
          <ul
            aria-label="Request kinds"
            className="flex min-w-0 items-center gap-x-4 overflow-hidden text-xs whitespace-nowrap text-muted-foreground lg:flex-wrap lg:gap-y-1"
          >
            {(Object.keys(SPAN_KINDS) as SpanKind[])
              .filter((kind) => !hideEmptyKinds || kindCounts[kind] > 0)
              .map((kind) => (
                <li
                  key={kind}
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    // An empty kind is a key to the colours; phones have no
                    // room for it.
                    kindCounts[kind] === 0 && "opacity-40 max-lg:hidden",
                  )}
                >
                  <span
                    className={cn(
                      "h-2 w-3 rounded-[2px]",
                      SPAN_KINDS[kind].bar,
                    )}
                    aria-hidden="true"
                  />
                  <span>{SPAN_KINDS[kind].label}</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {kindCounts[kind]}
                  </span>
                </li>
              ))}
            {guardSummary ? (
              <>
                <li className="inline-flex items-center gap-1.5">
                  <span
                    className={cn("h-1.5 w-3 rounded-full", CONSULT_KIND.bar)}
                    aria-hidden="true"
                  />
                  <span>{CONSULT_KIND.label}</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {guardSummary.consults}
                  </span>
                </li>
                <li className="inline-flex items-center gap-1.5 max-lg:hidden">
                  <span
                    aria-hidden="true"
                    className="relative inline-flex h-2 w-3 items-center"
                  >
                    <span className="absolute inset-x-0 top-1/2 h-px bg-muted-foreground/40" />
                    <HalfDisc side="left" className="relative mx-auto size-2 bg-card text-muted-foreground" />
                  </span>
                  <span>Label change</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {guardSummary.changes}
                  </span>
                </li>
              </>
            ) : null}
          </ul>
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground xl:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="ml-1">to step · {openHint}</span>
          </span>
        </div>
      </header>
      {notice}

      <div
        ref={scrollerRef}
        className="max-h-[50svh] overflow-auto overscroll-contain lg:max-h-[440px]"
      >
        <div className="lg:min-w-[920px]">
          {/* Column header and axis */}
          <div
            className={cn(
              // Sticks within the list's own scroll box, above the markers.
              "sticky top-0 z-[15] grid h-8 border-b bg-muted text-[11px] font-medium text-muted-foreground",
              grid,
            )}
          >
            <div className="flex items-center gap-1.5 pl-4">
              <span>Name</span>
              <span className="hidden font-normal text-muted-foreground/60 lg:inline">
                {layout === "tools" ? "server, time" : "model, time"}
              </span>
            </div>
            <div className="relative mx-2 lg:mx-3">
              {/* A phone's track is too narrow for tick labels. */}
              <span className="flex h-full items-center lg:hidden">
                Timeline
              </span>
              {timeline?.breaks.map((b) => (
                <span
                  key={`axis-break-${b.x}`}
                  className="absolute inset-y-0 hidden bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--color-border)_4px_5px)] lg:block"
                  style={{ left: `${b.x * 100}%`, width: `${b.w * 100}%` }}
                />
              ))}
              {ticks.map((tick) => (
                <span
                  key={`tick-${tick.x}`}
                  className={cn(
                    "absolute top-1/2 hidden -translate-y-1/2 whitespace-nowrap tabular-nums lg:block",
                    tick.x === 0
                      ? "translate-x-0"
                      : tick.x === 1
                        ? "-translate-x-full"
                        : "-translate-x-1/2",
                  )}
                  style={{ left: `${tick.x * 100}%` }}
                >
                  {tick.label}
                </span>
              ))}
              {timeline?.breaks.map((b) => (
                <span
                  key={`axis-idle-${b.x}`}
                  className="absolute top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 rounded-sm border bg-card px-1 text-[10px] leading-4 font-medium whitespace-nowrap text-foreground/80 tabular-nums lg:block"
                  style={{ left: `${(b.x + b.w / 2) * 100}%` }}
                >
                  {formatElapsed(b.gapMs)} idle
                </span>
              ))}
            </div>
            {layout === "trace" ? (
              <div className={cn(WIDE_ONLY, "items-center justify-end px-3")}>
                Tokens
              </div>
            ) : null}
            <div className="flex items-center justify-end pr-4">
              {layout === "tools" ? "Duration" : "Cost"}
            </div>
          </div>

          {loading ? (
            <WaterfallSkeleton layout={layout} />
          ) : !timeline || spans.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            <div className="relative">
              {/* Gridlines, idle breaks and the selection's edges, behind
                  every row. */}
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-0 grid",
                  grid,
                )}
              >
                <div />
                <div className="relative mx-2 lg:mx-3">
                  {timeline.ticks.map((tick) => (
                    <span
                      key={`grid-${tick.x}`}
                      className="absolute inset-y-0 w-px bg-border/50"
                      style={{ left: `${tick.x * 100}%` }}
                    />
                  ))}
                  {timeline.breaks.map((b) => (
                    <span
                      key={`fold-${b.x}`}
                      className="absolute inset-y-0 border-x border-dashed border-border bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--color-border)_4px_5px)] opacity-60"
                      style={{ left: `${b.x * 100}%`, width: `${b.w * 100}%` }}
                    />
                  ))}
                  {selected ? (
                    <>
                      <span
                        className="absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
                        style={{ left: `${selected.x * 100}%` }}
                      />
                      <span
                        className="absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
                        style={{
                          left: `${(selected.x + selected.w) * 100}%`,
                        }}
                      />
                    </>
                  ) : null}
                </div>
                {layout === "trace" ? (
                  <div className="hidden lg:block" />
                ) : null}
                <div />
              </div>

              <ol
                className="relative"
                onKeyDown={onKeyDown}
                aria-label="Requests"
              >
                {entries.map((entry) => {
                  if (entry.type === "consult") {
                    const { consult } = entry;
                    return (
                      <ConsultRow
                        key={consult.key}
                        consult={consult}
                        layout={layout}
                        linkedSelected={
                          consult.toolCallKey != null &&
                          consult.toolCallKey === selectedKey
                        }
                        onSelect={
                          consult.toolCallKey
                            ? () => onSelect(consult.toolCallKey as string)
                            : undefined
                        }
                      />
                    );
                  }
                  if (entry.type === "label") {
                    const key = entry.segment.cause?.toolCallKey ?? null;
                    return (
                      <LabelDivider
                        key={`label-${entry.segment.start}`}
                        segment={entry.segment}
                        previous={entry.previous}
                        layout={layout}
                        onSelect={key ? () => onSelect(key) : undefined}
                      />
                    );
                  }
                  const { span } = entry;
                  const rowProps = {
                    layout,
                    selected: span.key === selectedKey,
                    highlighted: span.key === highlightedKey,
                    buttonRef: (el: HTMLButtonElement | null) => {
                      if (el) rowRefs.current.set(span.key, el);
                      else rowRefs.current.delete(span.key);
                    },
                    onSelect: () => onSelect(span.key),
                    onOpen: () => onOpen(span),
                  };
                  return span.type === "request" ? (
                    <RequestRow
                      key={span.key}
                      span={span}
                      profileName={profileName}
                      isConversation={span.row.id === conversationRowId}
                      {...rowProps}
                    />
                  ) : (
                    <ToolCallRow
                      key={span.key}
                      span={span}
                      display={serverDisplayByName.get(span.call.mcpServerName)}
                      {...rowProps}
                    />
                  );
                })}
              </ol>
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="flex h-11 items-center justify-between gap-3 overflow-hidden border-t bg-muted/40 px-4 text-xs whitespace-nowrap text-muted-foreground tabular-nums lg:h-[45px]">
        {status ? (
          <span className="flex min-w-0 items-center gap-x-3 overflow-hidden lg:gap-x-2">
            {status}
          </span>
        ) : (
          <>
            <StatusText
              requests={spans.length - kindCounts.tool}
              toolCalls={kindCounts.tool}
              tokens={pageTotals.tokens}
              billed={pageTotals.billed}
              timeline={timeline}
              guard={guardSummary}
            />
            {pagination && pagination.total > pagination.pageSize ? (
              <StatusBarPagination
                pageIndex={pagination.pageIndex}
                pageSize={pagination.pageSize}
                total={pagination.total}
                onPaginationChange={pagination.onPaginationChange}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export function KindChip({ kind }: { kind: SpanKind }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
        SPAN_KINDS[kind].chip,
      )}
    >
      {SPAN_KINDS[kind].short}
    </span>
  );
}

/**
 * A logged MCP call's chip: "Tool" for a tool call, "Method" for the
 * protocol's own requests (`initialize`, `tools/list`), which run no tool.
 */
export function McpCallChip({ method }: { method: string }) {
  if (method === "tools/call") return <KindChip kind="tool" />;
  return (
    <span className="shrink-0 rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground">
      Method
    </span>
  );
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * "trace": Name, Model, Time, track, Tokens, Cost. "tools", when every row is
 * a tool call: Name, Server, Time, track, Duration.
 */
type Layout = "trace" | "tools";

// The Name cell carries two lines (name; model or server · clock time), so
// there are no separate Model and Time columns and the track takes their
// width. Phones keep Name, a compact track and the last figure; Tokens is
// display:none there, so it takes no grid track.
const GRIDS: Record<Layout, string> = {
  trace:
    "grid-cols-[minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_104px_84px]",
  tools:
    "grid-cols-[minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_84px]",
};
const WIDE_ONLY = "hidden lg:flex";
/** The sticky column header, which a row scrolled to the top must clear. */
const COLUMN_HEADER_PX = 32;

function scrollWithin(scroller: HTMLElement, row: HTMLElement) {
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = rect.top - box.top + scroller.scrollTop;
  const bottom = top + rect.height;
  if (top - COLUMN_HEADER_PX < scroller.scrollTop) {
    scroller.scrollTop = top - COLUMN_HEADER_PX;
  } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
    scroller.scrollTop = bottom - scroller.clientHeight;
  }
}

/**
 * Where a row's duration label goes: after its bar, before it when the bar
 * runs to the end, or on the bar's end when it spans the whole track.
 */
function placeLatency(
  span: Pick<TimelineSpan, "x" | "w">,
): "after" | "before" | "inside" {
  if (span.x + span.w <= 0.84) return "after";
  return span.x >= 0.18 ? "before" : "inside";
}

function StatusText({
  requests,
  toolCalls,
  tokens,
  billed,
  timeline,
  guard,
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
  guard: { consults: number; blocked: number } | null;
}) {
  // Phones keep the request count and the bill beside the paging (tokens
  // and the span are in the facts card); separators only exist where it is
  // all one line.
  const parts: { key: string; text: ReactNode; wideOnly?: boolean }[] = [
    {
      key: "count",
      text: (
        <span>
          {requests.toLocaleString()} {requests === 1 ? "request" : "requests"}
          <span className="hidden lg:inline"> on this page</span>
        </span>
      ),
    },
    ...(toolCalls > 0
      ? [
          {
            key: "tools",
            text: (
              <span>
                {toolCalls.toLocaleString()}{" "}
                {toolCalls === 1 ? "tool call" : "tool calls"}
              </span>
            ),
            wideOnly: true,
          },
        ]
      : []),
    {
      key: "tokens",
      text: <span>{formatCompactNumber(tokens)} tokens</span>,
      wideOnly: true,
    },
    { key: "billed", text: <span>{formatUsageCost(billed)} billed</span> },
  ];
  if (guard && guard.consults > 0) {
    parts.push({
      key: "guard",
      text: (
        <span>
          {guard.consults.toLocaleString()} guardrail checks
          {guard.blocked > 0 ? (
            <span className={DECISION_TONE.blocked.text}>
              {", "}
              {guard.blocked} blocked
            </span>
          ) : null}
        </span>
      ),
      wideOnly: true,
    });
  }
  if (timeline && timeline.realSpanMs > 0) {
    parts.push({
      key: "span",
      text: <span>{formatElapsed(timeline.realSpanMs)} span</span>,
      wideOnly: true,
    });
  }
  if (timeline && timeline.breaks.length > 0) {
    parts.push({
      key: "idle",
      text: (
        <span>
          {timeline.breaks.length} idle{" "}
          {timeline.breaks.length === 1 ? "stretch" : "stretches"} folded
        </span>
      ),
      wideOnly: true,
    });
  }
  return (
    <span className="flex min-w-0 items-center gap-x-3 overflow-hidden lg:gap-x-2">
      {parts.map((part, index) => (
        <span
          key={part.key}
          className={cn(
            "items-center gap-2",
            part.wideOnly ? "hidden lg:inline-flex" : "inline-flex",
          )}
        >
          {index > 0 ? (
            <span
              aria-hidden="true"
              className="hidden h-3 w-px bg-border lg:block"
            />
          ) : null}
          {part.text}
        </span>
      ))}
    </span>
  );
}

type RowProps = {
  layout: Layout;
  selected: boolean;
  highlighted: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onOpen: () => void;
};

/** One row's frame and track; the cells around the track vary by kind. */
function RowShell({
  span,
  label,
  layout,
  selected,
  highlighted,
  buttonRef,
  onSelect,
  onOpen,
  name,
  detail,
  time,
  latency,
  tokens,
  cost,
}: RowProps & {
  span: TimelineSpan;
  /** The row's accessible name. */
  label: string;
  name: ReactNode;
  /** Model or server; phones fold it under the name with the latency. */
  detail: ReactNode;
  time: string;
  latency: { text: string; label: string } | null;
  tokens: ReactNode;
  cost: ReactNode;
}) {
  const style = SPAN_KINDS[span.kind];
  const grid = GRIDS[layout];
  const tools = layout === "tools";
  const latencyPlacement = placeLatency(span);
  return (
    <li>
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={label}
        className={cn(
          "group grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
          grid,
          selected
            ? "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]"
            : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        <span className="flex min-w-0 items-center gap-2 pr-3 pl-4">
          <span
            className={cn(
              "h-[26px] w-[3px] shrink-0 rounded-full",
              style.bar,
              !selected && span.kind === "auxiliary" && "opacity-70",
            )}
            aria-hidden="true"
          />
          {span.kind !== "main" ? (
            <CornerDownRight
              className="-mr-0.5 size-3 shrink-0 self-start mt-[3px] text-muted-foreground/50"
              aria-hidden="true"
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            <span className="flex min-w-0 items-center gap-1.5 leading-[18px]">
              {name}
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[11px] leading-4 tabular-nums",
                selected ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              {detail}
              <span
                aria-hidden="true"
                className="shrink-0 text-muted-foreground/40"
              >
                ·
              </span>
              <span className="shrink-0 text-muted-foreground/80 max-lg:hidden">
                {time}
              </span>
              {/* The tools layout's last column is the duration already. */}
              <span className="shrink-0 lg:hidden">
                {tools ? time : (latency?.text ?? "—")}
              </span>
            </span>
          </span>
        </span>

        {/* Track */}
        <span className="relative mx-2 block lg:mx-3">
          <span
            className={cn(
              "absolute top-1/2 -translate-y-1/2",
              span.kind === "tool" ? "h-2 rounded-full" : "h-2.5 rounded-[2px]",
              style.bar,
              selected && "ring-2 ring-offset-1 ring-offset-card",
              selected && style.ring,
            )}
            style={{
              left: `${span.x * 100}%`,
              width: `max(5px, ${span.w * 100}%)`,
            }}
          />
          {latency && !tools ? (
            <span
              role="img"
              aria-label={latency.label}
              className={cn(
                "pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[11px] whitespace-nowrap tabular-nums lg:block",
                selected ? "text-foreground" : "text-muted-foreground",
                // A bar that fills the track leaves no room on either side,
                // so the label sits on its end instead of spilling into the
                // Time column.
                latencyPlacement === "inside" &&
                  "rounded-sm bg-card/90 px-1 leading-4",
              )}
              style={
                latencyPlacement === "after"
                  ? { left: `calc(${(span.x + span.w) * 100}% + 8px)` }
                  : latencyPlacement === "before"
                    ? { right: `calc(${(1 - span.x) * 100}% + 6px)` }
                    : { right: "2px" }
              }
            >
              {latency.text}
            </span>
          ) : null}
        </span>

        {/* Tokens */}
        {tools ? null : (
          <span
            className={cn(
              WIDE_ONLY,
              "items-center justify-end gap-1 px-3 text-muted-foreground tabular-nums",
            )}
          >
            {tokens}
          </span>
        )}

        {/* Cost, or a tool call's duration */}
        <span className="flex items-center justify-end gap-1.5 pr-4 tabular-nums">
          {tools ? (
            <span className={cn(!selected && "text-muted-foreground")}>
              {latency?.text ?? "—"}
            </span>
          ) : (
            cost
          )}
        </span>
      </UnstyledButton>
    </li>
  );
}

function RequestRow({
  span,
  profileName,
  isConversation,
  ...rowProps
}: RowProps & {
  span: RequestSpan;
  profileName: string | null;
  isConversation: boolean;
}) {
  const { row, kind } = span;
  const label = requestLabel(row, profileName);
  const origin = row.model
    ? describeModelOrigin({ model: row.model, interactionType: row.type })
    : null;
  const modelName = row.model ? shortModelName(row.model) : "Unknown model";
  const onPlan = row.billingMode === "subscription";
  const latency = formatLatency(row.durationMs);

  return (
    <RowShell
      span={span}
      {...rowProps}
      label={`${label}, ${modelName}, ${latency}${isConversation ? ", latest conversation" : ""}`}
      name={
        <>
          <span
            className={cn(
              "truncate text-[13px] font-medium",
              kind === "auxiliary" && "text-muted-foreground",
            )}
          >
            {label}
          </span>
          {kind !== "main" ? <KindChip kind={kind} /> : null}
          {isConversation ? (
            <MessageSquareText
              className="size-3.5 shrink-0 text-primary"
              aria-hidden="true"
            />
          ) : null}
        </>
      }
      detail={
        <>
          <span className="hidden shrink-0 lg:flex">
            <MakerDisc
              provider={
                origin && origin.kind !== "unknown" ? origin.provider : null
              }
              vendor={
                origin?.kind === "aggregator"
                  ? origin.provider
                  : (origin?.name ?? modelName)
              }
              size={13}
              ring={false}
            />
          </span>
          <span
            className="min-w-0 truncate lg:ml-0.5"
            title={row.model ?? undefined}
          >
            {modelName}
          </span>
        </>
      }
      time={formatDate({ date: row.createdAt, dateFormat: "HH:mm:ss" })}
      latency={
        row.durationMs != null
          ? { text: latency, label: `Total request latency: ${latency}` }
          : null
      }
      tokens={
        <>
          <span>{formatCompactNumber(row.inputTokens ?? 0)}</span>
          <ArrowRight
            className="size-3 text-muted-foreground/50"
            aria-hidden="true"
          />
          <span className="text-foreground/80">
            {formatCompactNumber(row.outputTokens ?? 0)}
          </span>
        </>
      }
      cost={
        // On a plan the figure is list price, never billed: dimmed with a
        // hollow mark, which fits the column where a chip did not.
        <span
          className={cn(
            "inline-flex items-center gap-1",
            onPlan ? "text-muted-foreground" : "font-medium",
          )}
          title={onPlan ? "On plan: list price, not billed" : undefined}
        >
          {onPlan ? (
            <>
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full ring-1 ring-muted-foreground/70 ring-inset"
              />
              <span className="sr-only">On plan,</span>
            </>
          ) : null}
          {formatRequestCost(Number(row.cost ?? 0))}
        </span>
      }
    />
  );
}

function ToolCallRow({
  span,
  display,
  ...rowProps
}: RowProps & {
  span: ToolCallSpan;
  display: McpServerDisplay | undefined;
}) {
  const { call } = span;
  const content = readMcpToolCall(call);
  const name = content.toolName ?? content.method;
  const server = display?.name ?? call.mcpServerName;
  const latency = formatLatency(call.durationMs);
  const { status } = content;
  const marked =
    status === "error" || status === "blocked" || status === "cancelled";
  const outcome =
    status === "error"
      ? ", failed"
      : marked
        ? `, ${MCP_TOOL_CALL_STATUS_LABELS[status].toLowerCase()}`
        : "";

  return (
    <RowShell
      span={span}
      {...rowProps}
      label={`${content.method === "tools/call" ? "Tool call" : "Method"} ${name} on ${server}, ${latency}${outcome}`}
      name={
        <>
          <span className="truncate font-mono text-[12px] font-medium">
            {name}
          </span>
          <McpCallChip method={content.method} />
          {marked ? <McpToolCallStatusIcon status={status} /> : null}
        </>
      }
      detail={
        <>
          <span className="hidden shrink-0 lg:flex">
            <McpCatalogIcon
              icon={display?.icon}
              catalogId={display?.catalogId}
              size={12}
            />
          </span>
          <span className="min-w-0 truncate lg:ml-0.5">{server}</span>
        </>
      }
      time={formatDate({ date: call.createdAt, dateFormat: "HH:mm:ss" })}
      latency={
        call.durationMs != null
          ? { text: latency, label: `Tool call duration: ${latency}` }
          : null
      }
      tokens={<span className="text-muted-foreground/50">—</span>}
      cost={<span className="text-muted-foreground/50">—</span>}
    />
  );
}

// ============================================================================
// Guardrails (arena)
// ============================================================================

/** One line of the list: a span, a guardrail consult, or a label change. */
type Entry =
  | { type: "span"; t: number; span: TimelineSpan }
  | { type: "consult"; t: number; consult: MockConsult }
  | {
      type: "label";
      t: number;
      segment: LabelSegment;
      previous: LabelSegment;
    };

// Literal classes so Tailwind sees them: each label's hairline tint.
const TRUST_LINE: Record<Trust, string> = {
  trusted: "via-emerald-500/45 dark:via-emerald-400/40",
  suspicious: "via-rose-500/50 dark:via-rose-400/45",
};
const AUDIENCE_LINE: Record<Audience, string> = {
  public: "via-sky-500/45 dark:via-sky-400/40",
  internal: "via-indigo-500/45 dark:via-indigo-400/40",
  "@payments": "via-violet-500/45 dark:via-violet-400/40",
  self: "via-fuchsia-500/45 dark:via-fuchsia-400/40",
};

/**
 * The label's mark: a half-filled disc, left half for trust and right half
 * for audience, so the two read apart at a glance without words.
 */
function HalfDisc({
  side,
  className,
}: {
  side: "left" | "right";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-2.5 shrink-0 rounded-full ring-1 ring-current ring-inset",
        side === "left"
          ? "bg-[linear-gradient(90deg,currentColor_50%,transparent_50%)]"
          : "bg-[linear-gradient(270deg,currentColor_50%,transparent_50%)]",
        className,
      )}
    />
  );
}

/** The toolbar's session label: at the selected row, or where it ended. */
function LabelBadge({
  trust,
  audience,
  atSelection,
  labels,
}: {
  trust: Trust;
  audience: Audience;
  atSelection: boolean;
  labels: LabelSegment[];
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Session label ${atSelection ? "at the selected row" : "at session end"}: ${TRUST_TONE[trust].label}, ${AUDIENCE_TONE[audience].label}`}
          className="inline-flex h-6 shrink-0 cursor-default items-center gap-2 rounded-md border bg-card px-2 text-[11px] leading-none font-medium"
        >
          <span
            className={cn("inline-flex items-center gap-1.5", TRUST_TONE[trust].text)}
          >
            <HalfDisc side="left" />
            {TRUST_TONE[trust].label}
          </span>
          <span aria-hidden="true" className="h-3 w-px bg-border" />
          <span
            className={cn(
              "inline-flex items-center gap-1.5",
              AUDIENCE_TONE[audience].text,
            )}
          >
            <HalfDisc side="right" />
            {AUDIENCE_TONE[audience].label}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" align="end" className="w-64 px-0 py-2">
        <p className="px-3 pb-1.5 font-medium">
          Session label {atSelection ? "at the selected row" : "at session end"}
        </p>
        <ol className="flex flex-col gap-1 border-t px-3 pt-1.5 text-[11px] tabular-nums">
          {labels.map((segment, index) => (
            <li key={segment.start} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-muted-foreground">
                {formatDate({
                  date: new Date(segment.start).toISOString(),
                  dateFormat: "HH:mm:ss",
                })}
              </span>
              <span className={cn("inline-flex items-center gap-1", TRUST_TONE[segment.trust].text)}>
                <HalfDisc side="left" className="size-2" />
                {TRUST_TONE[segment.trust].label}
              </span>
              <span className={cn("inline-flex items-center gap-1", AUDIENCE_TONE[segment.audience].text)}>
                <HalfDisc side="right" className="size-2" />
                {AUDIENCE_TONE[segment.audience].label}
              </span>
              {index === 0 ? (
                <span className="ml-auto text-muted-foreground/70">start</span>
              ) : null}
            </li>
          ))}
        </ol>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A guardrail consult: a short, quiet row under the tool call it gated or
 * labelled, with its decision in the last column. Not a keyboard stop; a
 * click selects the tool call it belongs to.
 */
function ConsultRow({
  consult,
  layout,
  linkedSelected,
  onSelect,
}: {
  consult: MockConsult;
  layout: Layout;
  linkedSelected: boolean;
  onSelect?: () => void;
}) {
  const decision = DECISION_TONE[consult.decision];
  const latency = formatLatency(consult.durationMs);
  const placement = placeLatency(consult);
  const DecisionIcon =
    consult.decision === "blocked"
      ? ShieldX
      : consult.backend === "hitl"
        ? UserCheck
        : ShieldCheck;
  const context = consult.toolName
    ? consult.beforeCall
      ? `before ${consult.toolName}`
      : `on ${consult.toolName}`
    : ROLE_LABEL[consult.role].toLowerCase();
  const details = (
    <ConsultDetails consult={consult} latency={latency} />
  );

  return (
    <li>
      <UnstyledButton
        tabIndex={-1}
        onClick={onSelect}
        aria-label={`Guardrail ${ROLE_LABEL[consult.role].toLowerCase()} ${consult.externalName} ${context}, ${decision.label.toLowerCase()}, ${latency}`}
        className={cn(
          "group grid h-9 w-full border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-8",
          GRIDS[layout],
          linkedSelected ? "bg-primary/[0.035]" : "hover:bg-muted/40",
          !onSelect && "cursor-default",
        )}
      >
        <span className="flex min-w-0 items-center gap-2 pr-3 pl-4">
          <span
            aria-hidden="true"
            className={cn(
              "h-4 w-[3px] shrink-0 rounded-full",
              CONSULT_KIND.bar,
              linkedSelected ? "opacity-100" : "opacity-55",
            )}
          />
          <CornerDownRight
            className="-mr-0.5 size-3 shrink-0 text-muted-foreground/40"
            aria-hidden="true"
          />
          <DecisionIcon
            className={cn("size-3.5 shrink-0", decision.text)}
            aria-hidden="true"
          />
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="shrink-0 font-mono text-[12px] text-foreground/85">
              {consult.externalName}
            </span>
            <span className="min-w-0 truncate text-[11px] text-muted-foreground">
              {context}
            </span>
          </span>
        </span>

        <span className="relative mx-2 block lg:mx-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                  CONSULT_KIND.bar,
                  consult.decision !== "blocked" && "opacity-80",
                )}
                style={{
                  left: `${consult.x * 100}%`,
                  width: `max(4px, ${consult.w * 100}%)`,
                }}
              />
            </TooltipTrigger>
            <TooltipContent side="top">{details}</TooltipContent>
          </Tooltip>
          <span
            aria-hidden="true"
            className={cn(
              "pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[11px] whitespace-nowrap text-muted-foreground/80 tabular-nums lg:block",
              placement === "inside" && "rounded-sm bg-card/90 px-1 leading-4",
            )}
            style={
              placement === "after"
                ? { left: `calc(${(consult.x + consult.w) * 100}% + 8px)` }
                : placement === "before"
                  ? { right: `calc(${(1 - consult.x) * 100}% + 6px)` }
                  : { right: "2px" }
            }
          >
            {latency}
          </span>
        </span>

        {layout === "trace" ? (
          <span
            className={cn(
              WIDE_ONLY,
              "items-center justify-end px-3 text-[11px] text-muted-foreground/60",
            )}
          >
            {ROLE_LABEL[consult.role]}
          </span>
        ) : null}

        <span className="flex items-center justify-end gap-1 pr-4">
          {consult.outcome !== "answered" ? (
            consult.outcome === "timeout" ? (
              <Clock
                className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                aria-label="Timed out"
              />
            ) : (
              <CircleAlert
                className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
                aria-label="Failed"
              />
            )
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                  decision.chip,
                )}
              >
                {decision.label}
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">{details}</TooltipContent>
          </Tooltip>
        </span>
      </UnstyledButton>
    </li>
  );
}

function ConsultDetails({
  consult,
  latency,
}: {
  consult: MockConsult;
  latency: string;
}) {
  const outcome =
    consult.outcome === "timeout"
      ? "Timed out"
      : consult.outcome === "non_success"
        ? "Failed to answer"
        : "Answered";
  return (
    <div className="flex max-w-72 flex-col gap-1 py-0.5">
      <div className="flex items-center gap-1.5">
        <span className="font-medium">{consult.externalName}</span>
        <span
          className={cn(
            "rounded-sm px-1 text-[10px] leading-4 font-medium",
            DECISION_TONE[consult.decision].chip,
          )}
        >
          {DECISION_TONE[consult.decision].label}
        </span>
      </div>
      <p className="text-muted-foreground">{consult.answer}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px] tabular-nums">
        <dt className="text-muted-foreground">Role</dt>
        <dd>{ROLE_LABEL[consult.role]}</dd>
        <dt className="text-muted-foreground">Backend</dt>
        <dd>{BACKEND_LABEL[consult.backend]}</dd>
        <dt className="text-muted-foreground">Outcome</dt>
        <dd>
          {outcome} in {latency}
        </dd>
        {consult.toolName ? (
          <>
            <dt className="text-muted-foreground">
              {consult.beforeCall ? "Gated" : "Read"}
            </dt>
            <dd className="font-mono">{consult.toolName}</dd>
          </>
        ) : null}
      </dl>
    </div>
  );
}

const BACKEND_LABEL: Record<MockConsult["backend"], string> = {
  llm: "LLM judge",
  hitl: "Human approval",
  archestra: "Archestra",
  url: "Webhook",
  jev: "JEV",
};

/**
 * A label change: a hairline across the list at the moment it happened,
 * with a pill naming what moved and why, and a tick on the axis.
 */
function LabelDivider({
  segment,
  previous,
  layout,
  onSelect,
}: {
  segment: LabelSegment;
  previous: LabelSegment;
  layout: Layout;
  onSelect?: () => void;
}) {
  const trustMoved = segment.trust !== previous.trust;
  const audienceMoved = segment.audience !== previous.audience;
  const cause = segment.cause;
  const why = !cause
    ? null
    : cause.kind === "reset"
      ? "reset"
      : cause.toolName
        ? `${cause.kind === "released" ? "on" : "after"} ${cause.toolName}`
        : null;
  const line = trustMoved
    ? TRUST_LINE[segment.trust]
    : AUDIENCE_LINE[segment.audience];
  const tick = trustMoved
    ? TRUST_TONE[segment.trust].bar
    : AUDIENCE_TONE[segment.audience].bar;
  const time = formatDate({
    date: new Date(segment.start).toISOString(),
    dateFormat: "HH:mm:ss",
  });
  const summary = [
    trustMoved ? `Trust to ${TRUST_TONE[segment.trust].label}` : null,
    audienceMoved ? `Audience to ${AUDIENCE_TONE[segment.audience].label}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <li
      aria-label={`Label change at ${time}: ${summary}${why ? `, ${why}` : ""}`}
      className="relative h-7 border-b border-border/40"
    >
      {/* The moment on the axis. */}
      <span
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 grid", GRIDS[layout])}
      >
        <span />
        <span className="relative mx-2 lg:mx-3">
          <span
            className={cn("absolute inset-y-1 w-px", tick)}
            style={{ left: `${segment.x * 100}%` }}
          />
        </span>
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-4 top-1/2 h-px bg-linear-to-r from-transparent to-transparent",
          line,
        )}
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-4 hidden -translate-y-1/2 text-[11px] text-muted-foreground/60 tabular-nums lg:block"
      >
        {time}
      </span>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            tabIndex={-1}
            onClick={onSelect}
            className={cn(
              "absolute top-1/2 left-1/2 inline-flex h-5 max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full border bg-card px-2 text-[11px] leading-none whitespace-nowrap shadow-xs outline-none transition-colors",
              onSelect ? "hover:bg-muted" : "cursor-default",
            )}
          >
            {trustMoved ? (
              <span className="inline-flex items-center gap-1">
                <HalfDisc side="left" className={TRUST_TONE[segment.trust].text} />
                <span className="text-muted-foreground">Trust</span>
                <ArrowRight className="size-2.5 text-muted-foreground/50" aria-hidden="true" />
                <span className={cn("font-medium", TRUST_TONE[segment.trust].text)}>
                  {TRUST_TONE[segment.trust].label.toLowerCase()}
                </span>
              </span>
            ) : null}
            {trustMoved && audienceMoved ? (
              <span aria-hidden="true" className="h-3 w-px bg-border" />
            ) : null}
            {audienceMoved ? (
              <span className="inline-flex items-center gap-1">
                <HalfDisc side="right" className={AUDIENCE_TONE[segment.audience].text} />
                <span className="text-muted-foreground">Audience</span>
                <ArrowRight className="size-2.5 text-muted-foreground/50" aria-hidden="true" />
                <span className={cn("font-medium", AUDIENCE_TONE[segment.audience].text)}>
                  {segment.audience.startsWith("@")
                    ? segment.audience
                    : AUDIENCE_TONE[segment.audience].label.toLowerCase()}
                </span>
              </span>
            ) : null}
            {why ? (
              <span className="min-w-0 truncate text-muted-foreground/80">
                <span aria-hidden="true" className="mr-1.5 text-muted-foreground/40">
                  ·
                </span>
                {why}
              </span>
            ) : null}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          <p className="font-medium">{cause?.summary ?? summary}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">
            {time} · from {TRUST_TONE[previous.trust].label},{" "}
            {AUDIENCE_TONE[previous.audience].label} to{" "}
            {TRUST_TONE[segment.trust].label},{" "}
            {AUDIENCE_TONE[segment.audience].label}
          </p>
        </TooltipContent>
      </Tooltip>
    </li>
  );
}

const SKELETON_PLACEMENTS = [
  [0, 30],
  [8, 12],
  [22, 40],
  [48, 10],
  [60, 25],
  [83, 17],
];

function WaterfallSkeleton({ layout }: { layout: Layout }) {
  return (
    <div>
      {SKELETON_PLACEMENTS.map(([x, w]) => (
        <div
          key={x}
          className={cn(
            "grid h-11 items-center border-b border-border/40 lg:h-10",
            GRIDS[layout],
          )}
        >
          <div className="flex min-w-0 flex-col gap-1.5 px-4">
            <Skeleton className="h-3 w-32 max-w-full" />
            <Skeleton className="h-2 w-24 max-w-full opacity-60" />
          </div>
          <div className="relative mx-2 h-full lg:mx-3">
            <Skeleton
              className="absolute top-1/2 h-2.5 -translate-y-1/2"
              style={{ left: `${x}%`, width: `${w}%` }}
            />
          </div>
          {layout === "trace" ? (
            <div className="hidden justify-end px-3 lg:flex">
              <Skeleton className="h-3 w-14" />
            </div>
          ) : null}
          <div className="flex justify-end pr-4">
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}
