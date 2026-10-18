"use client";
// design-arena: do not commit
import {
  AUDIENCE_TONE,
  type Audience,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
  type Trust,
} from "./guardrails-mock";

import {
  ArrowRight,
  CornerDownRight,
  MessageSquareText,
  Shield,
  ShieldAlert,
  ShieldX,
} from "lucide-react";
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

  // Consults grouped under the tool call they were raised for, and the
  // label strip's height, which rows scrolled to the top must also clear.
  const consultsByTool = useMemo(() => {
    const map = new Map<string, MockConsult[]>();
    for (const consult of guardrails?.consults ?? []) {
      if (!consult.toolCallKey) continue;
      const list = map.get(consult.toolCallKey) ?? [];
      list.push(consult);
      map.set(consult.toolCallKey, list);
    }
    return map;
  }, [guardrails]);
  const consultCounts = useMemo(() => {
    let gates = 0;
    let marks = 0;
    for (const consult of guardrails?.consults ?? []) {
      if (consult.beforeCall) gates++;
      else marks++;
    }
    return { gates, marks };
  }, [guardrails]);
  const showLanes = Boolean(guardrails) && !loading && spans.length > 0;
  const stickyPx = COLUMN_HEADER_PX + (showLanes ? LANES_PX : 0);

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

  // Keep the selection in view inside the list when it changes from outside
  // it (the details pane's stepper, a page change landing on a new default,
  // a link to one tool call). Only the list scrolls: moving the page would
  // yank a reader who is looking at the details pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = selectedKey ? rowRefs.current.get(selectedKey) : undefined;
    if (scroller && row) scrollWithin(scroller, row, stickyPx);
  }, [selectedKey, stickyPx]);

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
                  aria-hidden="true"
                  className="h-3 w-px shrink-0 bg-border max-lg:hidden"
                />
                <li className="inline-flex items-center gap-1.5 max-lg:hidden">
                  <Shield
                    className="size-3 text-muted-foreground"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span>Gated</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {consultCounts.gates}
                  </span>
                </li>
                <li className="inline-flex items-center gap-1.5 max-lg:hidden">
                  <span aria-hidden="true" className="inline-flex gap-[2px]">
                    <span className="h-2.5 w-[2px] rounded-full bg-indigo-500 dark:bg-indigo-400" />
                    <span className="h-2.5 w-[2px] rounded-full bg-amber-500 dark:bg-amber-400" />
                  </span>
                  <span>Labeled</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {consultCounts.marks}
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

          {showLanes && guardrails ? (
            <LabelLanes
              guardrails={guardrails}
              grid={grid}
              layout={layout}
              selected={selected}
            />
          ) : null}

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
                  const rowProps = {
                    layout,
                    selected: span.key === selectedKey,
                    highlighted: span.key === highlightedKey,
                    stickyPx,
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
                      consults={consultsByTool.get(span.key) ?? null}
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
/** The Trust / Audience lanes stuck under the column header. */
const LANES_PX = 28;

function scrollWithin(
  scroller: HTMLElement,
  row: HTMLElement,
  stickyPx: number,
) {
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = rect.top - box.top + scroller.scrollTop;
  const bottom = top + rect.height;
  if (top - stickyPx < scroller.scrollTop) {
    scroller.scrollTop = top - stickyPx;
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
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
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
  /** Height of the sticky header(s) a row scrolled into view must clear. */
  stickyPx: number;
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
  stickyPx,
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
  consults = null,
}: RowProps & {
  /** Guardrail consults raised for this tool call, drawn around its bar. */
  consults?: MockConsult[] | null;
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
  const gates = consults?.filter((c) => c.beforeCall) ?? [];
  const marks = consults?.filter((c) => !c.beforeCall) ?? [];
  // The gate's wait ends at the bar; the shield sits where it began.
  const gateX = gates.length
    ? Math.min(span.x, ...gates.map((c) => c.x))
    : span.x;
  const shieldPx = gates.length ? SHIELD_PX : 0;
  const marksPx = marks.length * MARK_STEP_PX;
  return (
    <li>
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={label}
        style={{ scrollMarginTop: stickyPx }}
        className={cn(
          "group grid h-11 w-full scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
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
          {consults?.length ? (
            <ConsultMarkers
              span={span}
              gates={gates}
              marks={marks}
              gateX={gateX}
            />
          ) : null}
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
                  ? {
                      left: marksPx
                        ? `calc(${barEnd(span)} + ${6 + marksPx}px)`
                        : `calc(${(span.x + span.w) * 100}% + 8px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - gateX) * 100}% + ${6 + shieldPx}px)`,
                      }
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
  consults,
  ...rowProps
}: RowProps & {
  span: ToolCallSpan;
  consults: MockConsult[] | null;
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
  const gate = consults?.find((c) => c.beforeCall);
  const guarded = gate
    ? gate.decision === "blocked"
      ? `, blocked by ${gate.externalName}`
      : `, ${DECISION_TONE[gate.decision].label.toLowerCase()} by ${gate.externalName}`
    : "";

  return (
    <RowShell
      span={span}
      {...rowProps}
      consults={consults}
      label={`${content.method === "tools/call" ? "Tool call" : "Method"} ${name} on ${server}, ${latency}${outcome}${guarded}`}
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

// ============================================================================
// Guardrails (arena): inline consult markers and the label lanes
// ============================================================================

/** The shield's box plus a 1px gap before the gate's wait. */
const SHIELD_PX = 15;
/** One after-call tick (2px) and its gap. */
const MARK_STEP_PX = 4;

const BACKEND_LABEL: Record<MockConsult["backend"], string> = {
  llm: "LLM",
  hitl: "human review",
  archestra: "Archestra",
  url: "webhook",
  jev: "JEV",
};

/** A bar's visual right edge: bars never draw narrower than 5px. */
function barEnd(span: Pick<TimelineSpan, "x" | "w">) {
  return `max(${(span.x + span.w) * 100}%, ${span.x * 100}% + 5px)`;
}

function clock(ms: number) {
  return formatDate({
    date: new Date(ms).toISOString(),
    dateFormat: "HH:mm:ss",
  });
}

function markTone(consult: MockConsult) {
  if (consult.outcome !== "answered") return "bg-rose-500 dark:bg-rose-400";
  if (consult.role === "sanitizer") return "bg-amber-500 dark:bg-amber-400";
  if (consult.role === "audience_source") return "bg-sky-500 dark:bg-sky-400";
  return "bg-indigo-500 dark:bg-indigo-400";
}

/**
 * A guarded tool call's marks: a shield where its gate started (with the
 * gate's wait as a dashed lead into the bar) and one tick per consult on
 * what it returned. Both open the same list of consults.
 */
function ConsultMarkers({
  span,
  gates,
  marks,
  gateX,
}: {
  span: TimelineSpan;
  gates: MockConsult[];
  marks: MockConsult[];
  gateX: number;
}) {
  const blocked = gates.some((c) => c.decision === "blocked");
  const stalled = gates.some((c) => c.outcome !== "answered");
  const Icon = blocked ? ShieldX : stalled ? ShieldAlert : Shield;
  const toolName = [...gates, ...marks][0]?.toolName ?? null;
  const list = (
    <ConsultList consults={[...gates, ...marks]} toolName={toolName} />
  );
  return (
    <>
      {gates.length ? (
        <>
          {span.x - gateX > 0.001 ? (
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute top-1/2 h-0 border-t border-dashed",
                blocked
                  ? "border-rose-500/60 dark:border-rose-400/60"
                  : "border-muted-foreground/35",
              )}
              style={{
                left: `${gateX * 100}%`,
                width: `${(span.x - gateX) * 100}%`,
              }}
            />
          ) : null}
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                className="absolute top-1/2 flex size-3.5 -translate-y-1/2 items-center justify-center"
                style={{ left: `calc(${gateX * 100}% - ${SHIELD_PX}px)` }}
              >
                <Icon
                  className={cn(
                    "size-3",
                    blocked
                      ? "text-rose-600 dark:text-rose-400"
                      : "text-muted-foreground/80",
                  )}
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="start" className="text-pretty">
              {list}
            </TooltipContent>
          </Tooltip>
        </>
      ) : null}
      {marks.length ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="absolute top-1/2 flex h-3.5 -translate-y-1/2 items-center gap-[2px] px-px"
              style={{ left: `calc(${barEnd(span)} + 2px)` }}
            >
              {marks.map((c) => (
                <span
                  key={c.key}
                  aria-hidden="true"
                  className={cn("h-2.5 w-[2px] rounded-full", markTone(c))}
                />
              ))}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" align="start" className="text-pretty">
            {list}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  );
}

function ConsultList({
  consults,
  toolName,
}: {
  consults: MockConsult[];
  toolName: string | null;
}) {
  return (
    <div className="flex w-[288px] flex-col gap-2 py-0.5 text-left">
      <div className="flex items-baseline justify-between gap-3 border-b pb-1.5">
        <span className="font-medium">
          {consults.length} guardrail{" "}
          {consults.length === 1 ? "consult" : "consults"}
        </span>
        {toolName ? (
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {toolName}
          </span>
        ) : null}
      </div>
      <ul className="flex flex-col gap-2">
        {consults.map((c) => (
          <li
            key={c.key}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">
                {c.beforeCall ? "Before" : "After"}
              </span>
              <span className="truncate font-medium">{c.externalName}</span>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                  DECISION_TONE[c.decision].chip,
                )}
              >
                {DECISION_TONE[c.decision].label}
              </span>
              {c.outcome !== "answered" ? (
                <span className="shrink-0 rounded-sm bg-rose-500/10 px-1 text-[10px] leading-4 font-medium text-rose-700 dark:text-rose-300">
                  {c.outcome === "timeout" ? "Timed out" : "Failed"}
                </span>
              ) : null}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatLatency(c.durationMs)}
            </span>
            <span className="col-span-2 text-[11px] leading-4 text-muted-foreground">
              {ROLE_LABEL[c.role]}, {BACKEND_LABEL[c.backend]}:{" "}
              <span className="text-foreground/80">{c.answer}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type LaneRun<T extends string> = {
  value: T;
  x: number;
  w: number;
  start: number;
  end: number;
  /** What moved this lane at `start` (null on the first run). */
  cause: LabelSegment["cause"];
};

/** Collapse the label timeline to the runs where one dimension holds still. */
function laneRuns<T extends string>(
  labels: LabelSegment[],
  pick: (segment: LabelSegment) => T,
): LaneRun<T>[] {
  const runs: LaneRun<T>[] = [];
  for (const segment of labels) {
    const value = pick(segment);
    const last = runs[runs.length - 1];
    if (last && last.value === value) {
      last.w = segment.x + segment.w - last.x;
      last.end = segment.end;
      continue;
    }
    runs.push({
      value,
      x: segment.x,
      w: segment.w,
      start: segment.start,
      end: segment.end,
      cause: runs.length === 0 ? null : segment.cause,
    });
  }
  return runs;
}

/**
 * Two hairline lanes stuck under the axis: the session's trust and audience
 * over time, broken where a tool result, a release or a reset moved them.
 * The name cell reads the label as of the selected row.
 */
function LabelLanes({
  guardrails,
  grid,
  layout,
  selected,
}: {
  guardrails: GuardrailsData;
  grid: string;
  layout: Layout;
  selected: TimelineSpan | null;
}) {
  const trust = useMemo(
    () => laneRuns<Trust>(guardrails.labels, (s) => s.trust),
    [guardrails],
  );
  const audience = useMemo(
    () => laneRuns<Audience>(guardrails.labels, (s) => s.audience),
    [guardrails],
  );
  const last = guardrails.labels[guardrails.labels.length - 1];
  const now = selected
    ? guardrails.labelAt(selected.start)
    : { trust: last.trust, audience: last.audience };

  return (
    <div
      className={cn(
        "sticky top-8 z-[14] grid h-7 border-b border-border/70 bg-card",
        grid,
      )}
    >
      <div className="grid grid-rows-2 pr-3 pl-4 text-[10px] leading-[14px]">
        <LaneReadout
          name="Trust"
          value={TRUST_TONE[now.trust].label}
          tone={TRUST_TONE[now.trust].text}
          selected={Boolean(selected)}
        />
        <LaneReadout
          name="Audience"
          value={AUDIENCE_TONE[now.audience].label}
          tone={AUDIENCE_TONE[now.audience].text}
          selected={Boolean(selected)}
        />
      </div>
      <div className="relative mx-2 lg:mx-3">
        <Lane
          top={0}
          runs={trust}
          bar={(v) => cn(TRUST_TONE[v].bar, "opacity-80")}
          label={(v) => TRUST_TONE[v].label}
          name="Trust"
        />
        <Lane
          top={14}
          runs={audience}
          bar={(v) => AUDIENCE_TONE[v].bar}
          label={(v) => AUDIENCE_TONE[v].label}
          name="Audience"
        />
        {selected ? (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
              style={{ left: `${selected.x * 100}%` }}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
              style={{ left: `${(selected.x + selected.w) * 100}%` }}
            />
          </>
        ) : null}
      </div>
      {layout === "trace" ? <div className="hidden lg:block" /> : null}
      <div />
    </div>
  );
}

function LaneReadout({
  name,
  value,
  tone,
  selected,
}: {
  name: string;
  value: string;
  tone: string;
  selected: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center justify-between gap-2">
      <span className="text-muted-foreground">{name}</span>
      <span className={cn("truncate font-medium", tone)}>
        <span className="sr-only">
          {selected ? "at the selected row: " : "at the end: "}
        </span>
        {value}
      </span>
    </span>
  );
}

/**
 * One lane: a 4px bar per run, centred in a 14px hover band, with a notch
 * at each change that explains what moved it.
 */
function Lane<T extends string>({
  top,
  runs,
  bar,
  label,
  name,
}: {
  top: number;
  runs: LaneRun<T>[];
  bar: (value: T) => string;
  label: (value: T) => string;
  name: string;
}) {
  return (
    <div className="absolute inset-x-0 h-[14px]" style={{ top }}>
      {runs.map((run, index) => (
        <Tooltip key={`run-${run.start}`}>
          <TooltipTrigger asChild>
            <span
              className="group/run absolute inset-y-0 flex items-center"
              style={{
                left: `${run.x * 100}%`,
                width: `${run.w * 100}%`,
              }}
            >
              <span
                className={cn(
                  "h-1 rounded-[1px] transition-[height] duration-100 group-hover/run:h-1.5",
                  index > 0 ? "ml-px w-[calc(100%-1px)]" : "w-full",
                  bar(run.value),
                )}
              />
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start">
            <span className="flex items-baseline gap-2">
              <span className="text-muted-foreground">{name}</span>
              <span className="font-medium">{label(run.value)}</span>
              <span className="text-muted-foreground tabular-nums">
                {clock(run.start)} to {clock(run.end)}
              </span>
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
      {runs.slice(1).map((run, index) => (
        <Tooltip key={`move-${run.start}`}>
          <TooltipTrigger asChild>
            <span
              className="group/move absolute inset-y-0 z-[1] flex w-2.5 -translate-x-1/2 justify-center"
              style={{ left: `${run.x * 100}%` }}
            >
              <span className="my-[2px] w-px rounded-full bg-foreground/60 group-hover/move:bg-foreground" />
            </span>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            align="center"
            className="w-[260px] text-pretty"
          >
            <span className="flex flex-col gap-1 text-left">
              <span className="flex items-baseline justify-between gap-3">
                <span className="font-medium">
                  {label(runs[index].value)}
                  <ArrowRight
                    className="mx-1 inline size-3 align-[-2px] text-muted-foreground"
                    aria-hidden="true"
                  />
                  {label(run.value)}
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {clock(run.start)}
                </span>
              </span>
              {run.cause ? (
                <>
                  <span className="text-[11px] leading-4 text-muted-foreground">
                    {run.cause.summary}
                  </span>
                  {run.cause.toolName ? (
                    <span className="truncate font-mono text-[11px] text-foreground/80">
                      {run.cause.toolName}
                    </span>
                  ) : null}
                </>
              ) : null}
            </span>
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}
