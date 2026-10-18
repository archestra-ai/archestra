"use client";
// design-arena: do not commit
import {
  AUDIENCE_TONE,
  CONSULT_KIND,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
} from "./guardrails-mock";

import { ArrowRight, CornerDownRight, MessageSquareText } from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
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

  // Guardrail consults, hung on the tool call they were raised for: gates
  // (authorities) just above the call, result handlers just below it.
  const consultsByCall = useMemo(() => {
    const map = new Map<
      string,
      { before: MockConsult[]; after: MockConsult[] }
    >();
    if (!guardrails) return map;
    const onPage = new Set(spans.map((span) => span.key));
    for (const consult of guardrails.consults) {
      if (!consult.toolCallKey || !onPage.has(consult.toolCallKey)) continue;
      const entry = map.get(consult.toolCallKey) ?? { before: [], after: [] };
      (consult.beforeCall ? entry.before : entry.after).push(consult);
      map.set(consult.toolCallKey, entry);
    }
    return map;
  }, [guardrails, spans]);
  const consultTotals = useMemo(() => {
    let count = 0;
    let blocked = 0;
    for (const { before, after } of consultsByCall.values()) {
      for (const consult of [...before, ...after]) {
        count++;
        if (consult.decision === "blocked") blocked++;
      }
    }
    return { count, blocked };
  }, [consultsByCall]);
  const [activeConsult, setActiveConsult] = useState<string | null>(null);

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

  // The label rail: each row takes the label in force at its start, and the
  // first row of a new segment carries the notch for that change. Rows are
  // rendered in order, so a running cursor finds each row's segment.
  let railCursor = -1;
  const railFor = (ms: number): RailCell | null => {
    if (!guardrails) return null;
    const { labels } = guardrails;
    let index = labels.findIndex((seg) => ms >= seg.start && ms < seg.end);
    if (index === -1) index = ms < labels[0].start ? 0 : labels.length - 1;
    const changed = railCursor !== -1 && index !== railCursor;
    const from = changed ? (labels[index - 1] ?? null) : null;
    railCursor = index;
    return { segment: labels[index], from, changed };
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
            {guardrails ? (
              <>
                <li
                  className={cn(
                    "inline-flex items-center gap-1.5",
                    consultTotals.count === 0 && "opacity-40 max-lg:hidden",
                  )}
                >
                  <span
                    className={cn("h-1.5 w-3 rounded-full", CONSULT_KIND.bar)}
                    aria-hidden="true"
                  />
                  <span>{CONSULT_KIND.label}</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {consultTotals.count}
                  </span>
                </li>
                <li className="inline-flex items-center">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex cursor-default items-center gap-1.5">
                        <span
                          aria-hidden="true"
                          className="flex h-3 w-[3px] flex-col overflow-hidden rounded-full"
                        >
                          <span className={cn("flex-1", RAIL_TONE.trusted)} />
                          <span
                            className={cn("flex-1", RAIL_TONE.suspicious)}
                          />
                        </span>
                        <span>Trust</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-60">
                      The session's guardrails label at each row's start, on the
                      left edge. A notch marks a change; hover it for the cause.
                    </TooltipContent>
                  </Tooltip>
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
                {spans.map((span) => {
                  const hung = consultsByCall.get(span.key);
                  const consultRow = (consult: MockConsult) => (
                    <ConsultRow
                      key={consult.key}
                      consult={consult}
                      layout={layout}
                      rail={railFor(consult.start)}
                      linked={span.key === selectedKey}
                      active={
                        activeConsult === consult.key &&
                        span.key === selectedKey
                      }
                      onSelect={() => {
                        setActiveConsult(consult.key);
                        onSelect(span.key);
                      }}
                      onOpen={() => onOpen(span)}
                    />
                  );
                  // In render order, so the rail cursor walks down the list.
                  const above = hung?.before.map(consultRow);
                  const rowProps = {
                    rail: railFor(span.start),
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
                  const row =
                    span.type === "request" ? (
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
                        display={serverDisplayByName.get(
                          span.call.mcpServerName,
                        )}
                        {...rowProps}
                      />
                    );
                  const below = hung?.after.map(consultRow);
                  return hung ? (
                    <Fragment key={span.key}>
                      {above}
                      {row}
                      {below}
                    </Fragment>
                  ) : (
                    row
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
              guardrails={guardrails ? consultTotals : null}
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
  guardrails,
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
  guardrails: { count: number; blocked: number } | null;
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
  if (guardrails && guardrails.count > 0) {
    parts.push({
      key: "guardrails",
      text: (
        <span>
          {guardrails.count.toLocaleString()} guardrail{" "}
          {guardrails.count === 1 ? "check" : "checks"}
          {guardrails.blocked > 0 ? (
            <span className={DECISION_TONE.blocked.text}>
              {" "}
              ({guardrails.blocked} blocked)
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
  /** The guardrails label at this row's start; null with OpenAPPA off. */
  rail: RailCell | null;
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
  rail,
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
    <li className={rail ? "relative" : undefined}>
      {rail ? <LabelRail cell={rail} /> : null}
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
            ? cn(
                "bg-primary/[0.07]",
                // The label rail covers the first 3px; the selection mark
                // sits just inside it.
                rail
                  ? "shadow-[inset_5px_0_0_var(--color-primary)]"
                  : "shadow-[inset_2px_0_0_var(--color-primary)]",
              )
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
// Guardrails (OpenAPPA): consult rows and the label rail
// ============================================================================

type RailCell = {
  segment: LabelSegment;
  /** The segment this row's label replaced, when it changed at this row. */
  from: LabelSegment | null;
  changed: boolean;
};

/** Trusted stays quiet; suspicious is the state worth noticing. */
const RAIL_TONE: Record<LabelSegment["trust"], string> = {
  trusted: "bg-emerald-500/45 dark:bg-emerald-400/40",
  suspicious: "bg-rose-500/85 dark:bg-rose-400/80",
};
const NOTCH_TONE: Record<LabelSegment["trust"], string> = {
  trusted: "bg-emerald-500 dark:bg-emerald-400",
  suspicious: "bg-rose-500 dark:bg-rose-400",
};
const CAUSE_VERB: Record<NonNullable<LabelSegment["cause"]>["kind"], string> = {
  admitted: "Admitted",
  narrowed: "Narrowed",
  released: "Released",
  reset: "Reset",
};

/**
 * A 3px cell of the session's label rail along the list's left edge. Cells
 * abut row to row, so the rail reads as one bar split by trust; a change
 * gets a notch at the top of the row it starts on.
 */
function LabelRail({ cell }: { cell: RailCell }) {
  const { segment, from, changed } = cell;
  const cause = segment.cause;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-[1] w-[3px]",
          RAIL_TONE[segment.trust],
        )}
      />
      {changed && cause ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              role="img"
              aria-label={`Guardrails label changed: ${cause.summary}`}
              className="absolute top-0 left-0 z-[2] flex h-3 w-4 cursor-default items-start"
            >
              <span
                className={cn(
                  "h-[3px] w-[9px] rounded-r-full ring-1 ring-card",
                  NOTCH_TONE[segment.trust],
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            align="start"
            className="flex max-w-72 flex-col gap-1.5 px-3 py-2"
          >
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              {CAUSE_VERB[cause.kind]}
              <span aria-hidden="true">·</span>
              <span className="tabular-nums">
                {formatDate({
                  date: new Date(segment.start).toISOString(),
                  dateFormat: "HH:mm:ss",
                })}
              </span>
            </span>
            <span className="flex flex-col gap-0.5">
              <LabelLine
                name="Trust"
                from={from ? TRUST_TONE[from.trust].label : null}
                to={TRUST_TONE[segment.trust].label}
                toClass={TRUST_TONE[segment.trust].text}
              />
              <LabelLine
                name="Audience"
                from={from ? AUDIENCE_TONE[from.audience].label : null}
                to={AUDIENCE_TONE[segment.audience].label}
                toClass={AUDIENCE_TONE[segment.audience].text}
              />
            </span>
            <span className="text-foreground/90">{cause.summary}</span>
            {cause.toolName ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {cause.toolName}
              </span>
            ) : null}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

function LabelLine({
  name,
  from,
  to,
  toClass,
}: {
  name: string;
  from: string | null;
  to: string;
  toClass: string;
}) {
  const same = from === to;
  return (
    <span className="grid grid-cols-[64px_1fr] items-center text-xs">
      <span className="text-muted-foreground">{name}</span>
      <span className="inline-flex items-center gap-1">
        {from && !same ? (
          <>
            <span className="text-muted-foreground line-through decoration-muted-foreground/40">
              {from}
            </span>
            <ArrowRight
              className="size-3 text-muted-foreground/60"
              aria-hidden="true"
            />
          </>
        ) : null}
        <span
          className={cn("font-medium", same ? "text-foreground/70" : toClass)}
        >
          {to}
        </span>
      </span>
    </span>
  );
}

/**
 * One guardrail consult, hung under (or over) the tool call it ran for: a
 * compact row in the guardrail colour with the decision as a coloured word.
 * It is not a step stop; clicking it selects its tool call.
 */
function ConsultRow({
  consult,
  layout,
  rail,
  linked,
  active,
  onSelect,
  onOpen,
}: {
  consult: MockConsult;
  layout: Layout;
  rail: RailCell | null;
  /** Its tool call is selected. */
  linked: boolean;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const decision = DECISION_TONE[consult.decision];
  const failed = consult.outcome !== "answered";
  const latency = formatLatency(consult.durationMs);
  const tools = layout === "tools";
  const placement = placeLatency(consult);
  const time = formatDate({
    date: new Date(consult.start).toISOString(),
    dateFormat: "HH:mm:ss",
  });
  const outcome =
    consult.outcome === "timeout"
      ? "Timed out"
      : consult.outcome === "non_success"
        ? "Failed"
        : null;
  return (
    <li className="relative">
      {rail ? <LabelRail cell={rail} /> : null}
      <UnstyledButton
        tabIndex={-1}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={`Guardrail ${ROLE_LABEL[consult.role].toLowerCase()} ${consult.externalName}, ${decision.label.toLowerCase()}, ${latency}${outcome ? `, ${outcome.toLowerCase()}` : ""}`}
        className={cn(
          "group grid h-9 w-full border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-8",
          GRIDS[layout],
          active
            ? "bg-primary/[0.07] shadow-[inset_5px_0_0_var(--color-primary)]"
            : linked
              ? "bg-primary/[0.025] hover:bg-muted/50"
              : "hover:bg-muted/50",
        )}
      >
        {/* Indented so the text lines up under its tool call's name. */}
        <span className="flex min-w-0 items-center gap-2 pr-3 pl-[34px]">
          <span
            aria-hidden="true"
            className={cn(
              "h-[20px] w-[2px] shrink-0 rounded-full",
              CONSULT_KIND.bar,
              !active && "opacity-70",
            )}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex min-w-0 items-center gap-1.5 leading-4">
                  <span className="truncate font-mono text-[11px] text-foreground/80">
                    {consult.externalName}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1 text-[10px] leading-[14px] font-medium",
                      CONSULT_KIND.chip,
                    )}
                  >
                    {CONSULT_KIND.short}
                  </span>
                </span>
                <span className="flex min-w-0 items-center gap-1 text-[10.5px] leading-[14px] text-muted-foreground tabular-nums">
                  <span className="shrink-0">{ROLE_LABEL[consult.role]}</span>
                  <span aria-hidden="true" className="text-muted-foreground/40">
                    ·
                  </span>
                  <span className={cn("shrink-0 font-medium", decision.text)}>
                    {decision.label}
                  </span>
                  {outcome ? (
                    <span className="shrink-0 text-amber-700 dark:text-amber-300">
                      {outcome}
                    </span>
                  ) : null}
                  <span className="ml-auto shrink-0 lg:hidden">{latency}</span>
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              align="start"
              className="flex max-w-72 flex-col gap-1 px-3 py-2"
            >
              <span className="text-[11px] font-medium text-muted-foreground">
                {ROLE_LABEL[consult.role]} · {consult.backend}
                {consult.beforeCall ? ", before the call" : ", on the result"}
              </span>
              <span className={cn("font-medium", decision.text)}>
                {decision.label}
                {outcome ? (
                  <span className="font-normal text-amber-700 dark:text-amber-300">
                    {" "}
                    ({outcome.toLowerCase()})
                  </span>
                ) : null}
              </span>
              <span className="text-foreground/90">{consult.answer}</span>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {time} · {latency}
              </span>
            </TooltipContent>
          </Tooltip>
        </span>

        {/* Track */}
        <span className="relative mx-2 block lg:mx-3">
          <span
            className={cn(
              "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
              failed
                ? "bg-transparent ring-1 ring-rose-400/80 ring-inset"
                : CONSULT_KIND.bar,
              !active && !failed && "opacity-80",
              active && "ring-2 ring-offset-1 ring-offset-card",
              active && CONSULT_KIND.ring,
            )}
            style={{
              left: `${consult.x * 100}%`,
              width: `max(4px, ${consult.w * 100}%)`,
            }}
          />
          {tools ? null : (
            <span
              className={cn(
                "pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[10.5px] whitespace-nowrap text-muted-foreground/80 tabular-nums lg:block",
                placement === "inside" &&
                  "rounded-sm bg-card/90 px-1 leading-4",
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
          )}
        </span>

        {tools ? null : <span className={WIDE_ONLY} />}
        <span className="flex items-center justify-end pr-4 text-[11px] text-muted-foreground tabular-nums">
          {tools ? latency : null}
        </span>
      </UnstyledButton>
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
