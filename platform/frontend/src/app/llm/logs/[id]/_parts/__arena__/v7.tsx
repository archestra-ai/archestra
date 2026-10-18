"use client";
// design-arena: do not commit
import { DecisionIcon } from "./guardrails-arena";
import {
  AUDIENCE_TONE,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
  type Trust,
} from "./guardrails-mock";

import {
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
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
  type InteractionSummary,
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
  selectedConsultKey = null,
  onSelectConsult,
}: {
  /** Mock OpenAPPA consults + label timeline (arena only). */
  guardrails?: GuardrailsData | null;
  /** The consult open in the details pane below, if any. */
  selectedConsultKey?: string | null;
  /**
   * Opens a consult in the details pane below (and selects its tool call).
   * Null closes it.
   */
  onSelectConsult?: (key: string | null) => void;
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

  // Guardrails: which label each row runs under, where it changes, and the
  // consults raised for each tool call on this page.
  const labelModel = useMemo(
    () => (guardrails ? buildLabelModel(spans, guardrails.labels) : null),
    [spans, guardrails],
  );
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
  const consultsOnPage = useMemo(
    () =>
      spans.reduce((n, span) => n + (consultsByTool.get(span.key)?.length ?? 0), 0),
    [spans, consultsByTool],
  );
  const stickyPx = labelModel ? COLUMN_HEADER_PX + LABEL_BAND_PX : COLUMN_HEADER_PX;

  // The row under the sticky label band. A jump pins its target so a change
  // near the end of the list (which cannot scroll to the top) still shows.
  const [topIndex, setTopIndex] = useState(0);
  const [pinIndex, setPinIndex] = useState<number | null>(null);
  const pinRef = useRef<{ index: number; scrollTop: number } | null>(null);
  const frameRef = useRef<number | null>(null);
  const measureTop = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !labelModel || spans.length === 0) return;
    const pin = pinRef.current;
    if (pin && Math.abs(scroller.scrollTop - pin.scrollTop) > 2) {
      pinRef.current = null;
      setPinIndex(null);
    }
    const line = scroller.getBoundingClientRect().top + stickyPx;
    let lo = 0;
    let hi = spans.length - 1;
    let found = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const el = rowRefs.current.get(spans[mid].key);
      if (!el) break;
      const rect = el.getBoundingClientRect();
      if (rect.top + rect.height / 2 > line) {
        found = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    setTopIndex(found);
  }, [spans, labelModel, stickyPx]);
  useEffect(() => {
    if (!loading) measureTop();
  }, [measureTop, loading]);
  // A new page drops any pinned jump target.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on page change
  useEffect(() => {
    pinRef.current = null;
    setPinIndex(null);
  }, [timeline]);
  const onScroll = labelModel
    ? () => {
        if (frameRef.current != null) return;
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          measureTop();
        });
      }
    : undefined;
  const focusIndex = Math.min(pinIndex ?? topIndex, spans.length - 1);

  /** Scrolls a change row under the band and selects it. */
  const jumpToRow = (index: number) => {
    const span = spans[index];
    if (!span) return;
    const scroller = scrollerRef.current;
    const el = rowRefs.current.get(span.key);
    if (scroller && el) {
      const box = scroller.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      scroller.scrollTop += rect.top - box.top - stickyPx;
      pinRef.current = { index, scrollTop: scroller.scrollTop };
      setPinIndex(index);
    }
    onSelect(span.key);
    el?.focus({ preventScroll: true });
  };

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
          </ul>
          {guardrails && consultsOnPage > 0 ? (
            <span
              className="inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground max-sm:hidden"
              title="Each shield on a row is a guardrail check. Click one to see its request and answer below."
            >
              <span
                aria-hidden="true"
                className="grid size-4 place-items-center rounded-full bg-card ring-1 ring-border"
              >
                <ShieldCheck className="size-2.5" />
              </span>
              <span>Guardrail checks</span>
              <span className="text-muted-foreground/70 tabular-nums">
                {consultsOnPage}
              </span>
            </span>
          ) : null}
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
        onScroll={onScroll}
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

          {labelModel && !loading && spans.length > 0 ? (
            <LabelBand
              model={labelModel}
              focusIndex={focusIndex}
              onJump={jumpToRow}
              selectedConsultKey={selectedConsultKey}
              onSelectConsult={onSelectConsult}
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
                {spans.map((span, index) => {
                  const change = labelModel?.changeByRow.get(index) ?? null;
                  const consults = consultsByTool.get(span.key) ?? null;
                  const rowProps = {
                    change,
                    consults,
                    selectedConsultKey,
                    onSelectConsult,
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
    "grid-cols-[minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_72px_84px]",
  tools:
    "grid-cols-[minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_84px]",
};
const WIDE_ONLY = "hidden lg:flex";
/** The sticky column header, which a row scrolled to the top must clear. */
const COLUMN_HEADER_PX = 32;

function scrollWithin(
  scroller: HTMLElement,
  row: HTMLElement,
  headerPx: number,
) {
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = rect.top - box.top + scroller.scrollTop;
  const bottom = top + rect.height;
  if (top - headerPx < scroller.scrollTop) {
    scroller.scrollTop = top - headerPx;
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
  /** The label change this row brings in, if any (guardrails only). */
  change: LabelChange | null;
  /** Guardrail consults raised for this row's tool call. */
  consults: MockConsult[] | null;
  selectedConsultKey: string | null;
  onSelectConsult?: (key: string | null) => void;
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
  change,
  consults,
  selectedConsultKey,
  onSelectConsult,
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
  const before = consults?.filter((c) => c.beforeCall) ?? [];
  const after = consults?.filter((c) => !c.beforeCall) ?? [];
  const barEnd = `${span.x * 100}% + max(5px, ${span.w * 100}%)`;
  return (
    <li className="relative">
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
          // Where the label switches: a full-width rule in the new label's
          // tone, with the change spelled out on the name's second line.
          change &&
            "relative before:absolute before:inset-x-0 before:top-0 before:h-0.5",
          change && CHANGE_RULE[change.tone],
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
              {change ? (
                <span
                  className={cn(
                    "inline-flex min-w-0 shrink items-center gap-0.5 truncate rounded-sm px-1 text-[10px] leading-4 font-semibold",
                    CHANGE_NOTE[change.tone],
                  )}
                  title={change.summary}
                >
                  <span className="truncate">{change.note}</span>
                </span>
              ) : null}
              {change ? (
                <span className="flex min-w-0 items-center gap-1 max-lg:hidden">
                  {detail}
                </span>
              ) : (
                detail
              )}
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
                  ? after.length > 0
                    ? {
                        left: `calc(${barEnd} + ${8 + after.length * SHIELD_STEP_PX}px)`,
                      }
                    : { left: `calc(${(span.x + span.w) * 100}% + 8px)` }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + before.length * SHIELD_STEP_PX}px)`,
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
              "items-center justify-end px-3 text-muted-foreground tabular-nums",
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
          ) : consults && consults.length > 0 ? (
            // Phones show the checks in this cell instead.
            <span className="max-lg:invisible">{cost}</span>
          ) : (
            cost
          )}
        </span>
      </UnstyledButton>
      {consults && consults.length > 0 && onSelectConsult ? (
        // The checks sit over the row, not inside its button, so each one is
        // its own button that opens the consult in the details pane.
        <div
          className={cn("pointer-events-none absolute inset-0 grid", grid)}
        >
          <span />
          <span className="relative mx-2 lg:mx-3">
            {before.length > 0 ? (
              <span
                className="absolute top-1/2 hidden -translate-y-1/2 items-center gap-0.5 lg:flex"
                style={{ right: `calc(${(1 - span.x) * 100}% + 3px)` }}
              >
                {before.map((consult) => (
                  <ShieldButton
                    key={consult.key}
                    consult={consult}
                    selected={consult.key === selectedConsultKey}
                    onOpen={() => onSelectConsult(consult.key)}
                  />
                ))}
              </span>
            ) : null}
            {after.length > 0 ? (
              <span
                className="absolute top-1/2 hidden -translate-y-1/2 items-center gap-0.5 lg:flex"
                style={{ left: `calc(${barEnd} + 3px)` }}
              >
                {after.map((consult) => (
                  <ShieldButton
                    key={consult.key}
                    consult={consult}
                    selected={consult.key === selectedConsultKey}
                    onOpen={() => onSelectConsult(consult.key)}
                  />
                ))}
              </span>
            ) : null}
            {tools ? (
              <span className="absolute inset-y-0 right-0 flex items-center lg:hidden">
                {consults.map((consult) => (
                  <ShieldButton
                    key={consult.key}
                    consult={consult}
                    selected={consult.key === selectedConsultKey}
                    onOpen={() => onSelectConsult(consult.key)}
                  />
                ))}
              </span>
            ) : null}
          </span>
          {tools ? null : <span className="hidden lg:block" />}
          <span className="flex items-center justify-end pr-2 lg:hidden">
            {tools
              ? null
              : consults.map((consult) => (
                  <ShieldButton
                    key={consult.key}
                    consult={consult}
                    selected={consult.key === selectedConsultKey}
                    onOpen={() => onSelectConsult(consult.key)}
                  />
                ))}
          </span>
        </div>
      ) : null}
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
      tokens={<TokensStack row={row} />}
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

// ----------------------------------------------------------------------------
// Guardrails: sticky label band, change rows, consult shields
// ----------------------------------------------------------------------------

/** The label band's height, which a row scrolled to the top must also clear. */
const LABEL_BAND_PX = 36;
/** One shield button plus the gap to the next. */
const SHIELD_STEP_PX = 22;

/** A trust change takes the trust tone; an audience-only change its own. */
type ChangeTone = Trust | "audience";

type LabelChange = {
  /** Index of the segment this change starts. */
  seg: number;
  /** Index of the row that brings it in. */
  row: number;
  /** In words: "Trust → Suspicious", "Audience → Internal". */
  note: string;
  tone: ChangeTone;
  summary: string;
  toolName: string | null;
  at: number;
};

type LabelModel = {
  segs: LabelSegment[];
  /** The segment each row runs under; never goes backwards down the list. */
  rowSeg: number[];
  changes: LabelChange[];
  changeByRow: Map<number, LabelChange>;
};

const CHANGE_RULE: Record<ChangeTone, string> = {
  suspicious: "before:bg-rose-500 dark:before:bg-rose-400",
  trusted: "before:bg-emerald-500 dark:before:bg-emerald-400",
  audience: "before:bg-indigo-500/80 dark:before:bg-indigo-400/80",
};

const CHANGE_NOTE: Record<ChangeTone, string> = {
  suspicious: "bg-rose-500/12 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
  trusted:
    "bg-emerald-500/12 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
  audience:
    "bg-indigo-500/12 text-indigo-700 dark:bg-indigo-400/15 dark:text-indigo-300",
};

function buildLabelModel(
  spans: TimelineSpan[],
  segs: LabelSegment[],
): LabelModel {
  const indexByKey = new Map(spans.map((span, i) => [span.key, i]));
  const segOf = (ms: number) => {
    let found = 0;
    for (let i = 0; i < segs.length; i++) if (ms >= segs[i].start) found = i;
    return found;
  };
  const changeByRow = new Map<number, LabelChange>();
  for (let seg = 1; seg < segs.length; seg++) {
    const from = segs[seg - 1];
    const to = segs[seg];
    const cause = to.cause;
    let row = cause?.toolCallKey ? indexByKey.get(cause.toolCallKey) : undefined;
    if (row === undefined) {
      const next = spans.findIndex((span) => span.start >= to.start);
      if (next === -1) continue;
      row = next;
    }
    const parts: string[] = [];
    if (from.trust !== to.trust)
      parts.push(`Trust → ${TRUST_TONE[to.trust].label}`);
    if (from.audience !== to.audience)
      parts.push(`Audience → ${AUDIENCE_TONE[to.audience].label}`);
    if (parts.length === 0) continue;
    changeByRow.set(row, {
      seg,
      row,
      note: parts.join(", "),
      tone: from.trust !== to.trust ? to.trust : "audience",
      summary: cause?.summary ?? "Label changed",
      toolName: cause?.toolName ?? null,
      at: to.start,
    });
  }
  const rowSeg: number[] = [];
  let running = 0;
  spans.forEach((span, i) => {
    running = Math.max(
      running,
      segOf(span.start),
      changeByRow.get(i)?.seg ?? 0,
    );
    rowSeg.push(running);
  });
  const changes = [...changeByRow.values()].sort((a, b) => a.row - b.row);
  return { segs, rowSeg, changes, changeByRow };
}

/**
 * Pinned under the axis: the label in force at the first visible row, what
 * set it (click to jump there), and ‹ › to step through the changes.
 */
function LabelBand({
  model,
  focusIndex,
  onJump,
  selectedConsultKey,
  onSelectConsult,
}: {
  model: LabelModel;
  focusIndex: number;
  onJump: (row: number) => void;
  selectedConsultKey: string | null;
  onSelectConsult?: (key: string | null) => void;
}) {
  const segIndex = model.rowSeg[focusIndex] ?? 0;
  const seg = model.segs[segIndex];
  if (!seg) return null;
  const current = model.changes.find((c) => c.seg === segIndex) ?? null;
  const prev =
    [...model.changes].reverse().find((c) => c.row < focusIndex) ?? null;
  const next = model.changes.find((c) => c.row > focusIndex) ?? null;
  const passed = model.changes.filter((c) => c.row <= focusIndex).length;
  const total = model.changes.length;
  const consultKey = seg.cause?.consultKey ?? null;
  const trust = TRUST_TONE[seg.trust];
  const audience = AUDIENCE_TONE[seg.audience];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`Label at this point: trust ${trust.label}, audience ${audience.label}`}
      className="sticky top-8 z-[14] flex h-9 items-center gap-1.5 border-b bg-card/95 pr-2 pl-4 text-xs backdrop-blur-sm sm:gap-2 lg:pr-3"
    >
      <span className="shrink-0 text-[11px] text-muted-foreground max-sm:hidden">
        <span className="lg:hidden">Label</span>
        <span className="hidden lg:inline">Label at this point</span>
      </span>
      <span
        key={segIndex}
        className="flex min-w-0 items-center gap-1.5 duration-300 animate-in fade-in-0 zoom-in-95"
      >
        <LabelChip
          kind="Trust"
          value={trust.label}
          dot={trust.bar}
          className={cn(trust.soft, trust.text)}
        />
        <LabelChip
          kind="Audience"
          value={audience.label}
          dot={audience.bar}
          className={cn("bg-muted", audience.text)}
        />
      </span>
      <span className="hidden min-w-0 items-center gap-1 sm:flex">
        {current ? (
          <UnstyledButton
            onClick={() => onJump(current.row)}
            title={current.summary}
            className="inline-flex h-6 min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <span className="shrink-0">since</span>
            <span className="truncate font-mono text-[11px] text-foreground/85 underline decoration-dotted underline-offset-2">
              {current.toolName ?? "a label change"}
            </span>
            <span className="shrink-0 tabular-nums max-xl:hidden">
              · {formatDate({ date: new Date(current.at).toISOString(), dateFormat: "HH:mm:ss" })}
            </span>
          </UnstyledButton>
        ) : (
          <span className="truncate px-1.5 text-muted-foreground">
            {segIndex === 0
              ? "since the session started"
              : (seg.cause?.summary ?? "")}
          </span>
        )}
        {consultKey && onSelectConsult ? (
          <UnstyledButton
            onClick={() => onSelectConsult(consultKey)}
            aria-pressed={selectedConsultKey === consultKey}
            aria-label="Open the guardrail check that set this label"
            className={cn(
              "inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 text-muted-foreground ring-1 ring-border transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none",
              selectedConsultKey === consultKey &&
                "bg-primary/10 text-foreground ring-primary/60",
            )}
          >
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            Why?
          </UnstyledButton>
        ) : null}
      </span>
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <span className="mr-1 text-[11px] text-muted-foreground tabular-nums max-md:hidden">
          {total === 0
            ? "No label changes"
            : passed === 0
              ? `${total} ${total === 1 ? "change" : "changes"} ahead`
              : `Change ${passed} of ${total}`}
        </span>
        <ChangeNavButton direction="prev" target={prev} onJump={onJump} />
        <ChangeNavButton direction="next" target={next} onJump={onJump} />
      </span>
    </div>
  );
}

function LabelChip({
  kind,
  value,
  dot,
  className,
}: {
  kind: string;
  value: string;
  dot: string;
  className: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 font-semibold whitespace-nowrap",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("size-1.5 shrink-0 rounded-full", dot)}
      />
      <span className="font-normal opacity-75">{kind}</span>
      <span className="truncate">{value}</span>
    </span>
  );
}

function ChangeNavButton({
  direction,
  target,
  onJump,
}: {
  direction: "prev" | "next";
  target: LabelChange | null;
  onJump: (row: number) => void;
}) {
  const Icon = direction === "prev" ? ChevronLeft : ChevronRight;
  const verb = direction === "prev" ? "Previous" : "Next";
  const button = (
    <UnstyledButton
      disabled={!target}
      onClick={() => target && onJump(target.row)}
      aria-label={
        target
          ? `${verb} label change: ${target.note}${target.toolName ? ` at ${target.toolName}` : ""}`
          : `No ${verb.toLowerCase()} label change`
      }
      className="grid size-7 cursor-pointer place-items-center rounded-md border bg-card text-foreground/80 transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none disabled:cursor-default disabled:opacity-35 disabled:hover:bg-card"
    >
      <Icon className="size-4" aria-hidden="true" />
    </UnstyledButton>
  );
  if (!target) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">
        <span className="font-medium">{verb} change:</span> {target.note}
        {target.toolName ? (
          <span className="opacity-70"> · {target.toolName}</span>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One guardrail consult: a 20px pill around the decision's shield. Opens the
 * consult in the details pane below; the open one is ringed in primary.
 */
function ShieldButton({
  consult,
  selected,
  onOpen,
}: {
  consult: MockConsult;
  selected: boolean;
  onOpen: () => void;
}) {
  const decision = DECISION_TONE[consult.decision];
  const flagged =
    consult.decision === "blocked"
      ? "bg-rose-500/10 ring-rose-500/60 dark:ring-rose-400/60"
      : consult.outcome !== "answered"
        ? "bg-amber-500/10 ring-amber-500/60 dark:ring-amber-400/60"
        : "bg-card ring-border";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          aria-pressed={selected}
          aria-label={`Guardrail check: ${ROLE_LABEL[consult.role]} ${consult.externalName}, ${decision.label}. Open details`}
          className={cn(
            "pointer-events-auto grid size-5 shrink-0 cursor-pointer place-items-center rounded-full shadow-xs ring-1 transition-[transform,background-color,box-shadow] duration-100",
            flagged,
            "hover:scale-110 hover:bg-muted hover:ring-foreground/40",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            selected &&
              "z-10 scale-110 bg-primary/15 ring-2 ring-primary hover:bg-primary/20 hover:ring-primary",
          )}
        >
          <DecisionIcon
            consult={consult}
            className={cn(selected && consult.decision !== "blocked" && "text-primary")}
          />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <div className="font-medium">
          {ROLE_LABEL[consult.role]} · {consult.externalName}
        </div>
        <div className="truncate opacity-90">
          {decision.label} — {consult.answer}
        </div>
        <div className="opacity-70">
          {consult.beforeCall ? "Before the call" : "On the result"} ·{" "}
          {formatLatency(consult.durationMs)}
          {consult.outcome !== "answered" ? ` · ${consult.outcome.replace("_", " ")}` : ""}{" "}
          · click to open
        </div>
      </TooltipContent>
    </Tooltip>
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

/**
 * Output on top, the figure that varies most from request to request, with
 * the input under it, labeled, in the name cell's two-line rhythm. Exact
 * counts and the cache split are on hover.
 */
function TokensStack({ row }: { row: InteractionSummary }) {
  const lines = [
    { label: "Output", value: row.outputTokens },
    { label: "Input", value: row.inputTokens },
    { label: "Cache read", value: row.cacheReadTokens, minor: true },
    { label: "Cache write", value: row.cacheWriteTokens, minor: true },
  ].filter((line) => !line.minor || line.value);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex flex-col items-end leading-tight tabular-nums">
          <span className="text-[13px] text-foreground/90">
            {formatCompactNumber(row.outputTokens ?? 0)}
          </span>
          <span className="flex items-baseline gap-1 text-[10px] text-muted-foreground/70">
            <span className="text-[9px] tracking-wide uppercase">in</span>
            {formatCompactNumber(row.inputTokens ?? 0)}
          </span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="left" className="tabular-nums">
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5">
          {lines.map((line) => (
            <div
              key={line.label}
              className={cn("contents", line.minor && "opacity-70")}
            >
              <dt>{line.label}</dt>
              <dd className="text-right">
                {(line.value ?? 0).toLocaleString()}
              </dd>
            </div>
          ))}
        </dl>
      </TooltipContent>
    </Tooltip>
  );
}
