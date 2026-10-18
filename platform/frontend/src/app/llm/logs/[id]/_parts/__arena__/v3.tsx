"use client";
// design-arena: do not commit
import { DecisionIcon } from "./guardrails-arena";
import {
  AUDIENCE_TONE,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type LabelState,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
} from "./guardrails-mock";

import {
  ArrowRight,
  CornerDownRight,
  MessageSquareText,
  MousePointerClick,
} from "lucide-react";
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
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
  const grid = guardrails ? GUARD_GRIDS[layout] : GRIDS[layout];
  const stickyRef = useRef<HTMLDivElement>(null);

  // Guardrails: each tool call's checks, and where each label change lands
  // in the list (the first row that runs under the new label).
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
  const changesBefore = useMemo(() => {
    const map = new Map<string, { segment: LabelSegment; prev: LabelState }>();
    if (!guardrails) return map;
    guardrails.labels.forEach((segment, index) => {
      if (index === 0) return;
      const first = spans.find((span) => span.start >= segment.start);
      if (first && !map.has(first.key)) {
        map.set(first.key, { segment, prev: guardrails.labels[index - 1] });
      }
    });
    return map;
  }, [guardrails, spans]);

  // The minimap's window: the time range of the rows in view.
  const [view, setView] = useState<{ a: number; b: number } | null>(null);
  const updateView = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!guardrails || !scroller) return;
    if (scroller.scrollHeight <= scroller.clientHeight + 1) {
      setView(null);
      return;
    }
    const header = stickyRef.current?.offsetHeight ?? COLUMN_HEADER_PX;
    const top = scroller.scrollTop;
    const bottom = top + scroller.clientHeight - header;
    let a = 1;
    let b = 0;
    for (const span of spans) {
      const el = rowRefs.current.get(span.key);
      if (!el) continue;
      const rowTop = el.offsetTop;
      if (rowTop + el.offsetHeight <= top || rowTop >= bottom) continue;
      a = Math.min(a, span.x);
      b = Math.max(b, span.x + span.w);
    }
    setView(b > a ? { a, b } : null);
  }, [guardrails, spans]);
  useEffect(() => {
    updateView();
  }, [updateView]);
  const viewFrame = useRef(0);
  const onScroll = guardrails
    ? () => {
        cancelAnimationFrame(viewFrame.current);
        viewFrame.current = requestAnimationFrame(updateView);
      }
    : undefined;

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
    if (scroller && row)
      scrollWithin(
        scroller,
        row,
        stickyRef.current?.offsetHeight ?? COLUMN_HEADER_PX,
      );
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
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground xl:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="ml-1">to step · {openHint}</span>
          </span>
        </div>
      </header>
      {notice}
      {guardrails ? (
        <PhoneLabelBar
          guardrails={guardrails}
          selected={selected}
          changes={changesBefore.size}
        />
      ) : null}

      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="max-h-[50svh] overflow-auto overscroll-contain lg:max-h-[440px]"
      >
        <div className="lg:min-w-[920px]">
          {/* Sticks within the list's own scroll box, above the markers. */}
          <div ref={stickyRef} className="sticky top-0 z-[15]">
            {guardrails && timeline && spans.length > 0 ? (
              <LabelStrip
                guardrails={guardrails}
                spans={spans}
                layout={layout}
                selected={selected}
                selectedConsultKey={selectedConsultKey}
                onSelect={onSelect}
                onSelectConsult={onSelectConsult}
                view={view}
                profileName={profileName}
              />
            ) : null}
            {/* Column header and axis */}
            <div
              className={cn(
                "grid h-8 border-b bg-muted text-[11px] font-medium text-muted-foreground",
                grid,
              )}
            >
              {guardrails ? <div className="lg:hidden" /> : null}
              <div
                className={cn(
                  "flex items-center gap-1.5",
                  guardrails ? "pl-1 lg:pl-4" : "pl-4",
                )}
              >
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
                {guardrails ? <div className="lg:hidden" /> : null}
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
                  {/* Where the label switches, through every row. */}
                  {guardrails?.labels.slice(1).map((segment) => (
                    <span
                      key={`label-change-${segment.start}`}
                      className={cn(
                        "absolute inset-y-0 hidden w-px opacity-50 lg:block",
                        TRUST_TONE[segment.trust].bar,
                      )}
                      style={{ left: `${segment.x * 100}%` }}
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
                    buttonRef: (el: HTMLButtonElement | null) => {
                      if (el) rowRefs.current.set(span.key, el);
                      else rowRefs.current.delete(span.key);
                    },
                    onSelect: () => onSelect(span.key),
                    onOpen: () => onOpen(span),
                    guardLabel: guardrails
                      ? guardrails.labelAt(span.start)
                      : null,
                  };
                  const change = changesBefore.get(span.key);
                  const banner = change ? (
                    <PhoneChangeBanner
                      key={`change-${span.key}`}
                      segment={change.segment}
                      prev={change.prev}
                      onSelect={onSelect}
                      onSelectConsult={onSelectConsult}
                    />
                  ) : null;
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
                        consults={consultsByTool.get(span.key) ?? null}
                        selectedConsultKey={selectedConsultKey}
                        onSelectConsult={onSelectConsult}
                        {...rowProps}
                      />
                    );
                  return banner ? (
                    <Fragment key={span.key}>
                      {banner}
                      {row}
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
/** Phones add the label gutter as a first column; wide screens are unchanged. */
const GUARD_GRIDS: Record<Layout, string> = {
  trace:
    "grid-cols-[16px_minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_72px_84px]",
  tools:
    "grid-cols-[16px_minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(232px,296px)_minmax(360px,1fr)_84px]",
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
  layout: Layout;
  selected: boolean;
  highlighted: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onOpen: () => void;
  /** The guardrails label in force when the row started (phones' gutter). */
  guardLabel: LabelState | null;
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
  guardLabel,
  trackExtras,
}: RowProps & {
  /** Marks drawn on the track behind nothing, such as a call's checks. */
  trackExtras?: ReactNode;
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
        {guardLabel ? <LabelGutter label={guardLabel} /> : null}
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 pr-3",
            guardLabel ? "pl-1 lg:pl-4" : "pl-4",
          )}
        >
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
          {trackExtras}
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
  consults = null,
  selectedConsultKey = null,
  onSelectConsult,
  ...rowProps
}: RowProps & {
  span: ToolCallSpan;
  display: McpServerDisplay | undefined;
  consults?: MockConsult[] | null;
  selectedConsultKey?: string | null;
  onSelectConsult?: (key: string | null) => void;
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
          {consults && onSelectConsult ? (
            <GuardChip
              consults={consults}
              rowSelected={rowProps.selected}
              selectedConsultKey={selectedConsultKey}
              onSelectConsult={onSelectConsult}
            />
          ) : null}
        </>
      }
      trackExtras={
        consults ? (
          <ConsultMarks
            consults={consults}
            selectedConsultKey={selectedConsultKey}
          />
        ) : null
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

// ============================================================================
// Guardrails (arena)
// ============================================================================

/**
 * Wide screens: the label timeline, aligned to the track. Tinted segments
 * say the label in words, a pill at each change says what changed (and
 * selects the call that caused it), consult ticks open their check below,
 * and the whole strip is a minimap: the box is the rows in view, a click
 * anywhere selects the nearest record, hovering reads out the moment.
 */
function LabelStrip({
  guardrails,
  spans,
  layout,
  selected,
  selectedConsultKey,
  onSelect,
  onSelectConsult,
  view,
  profileName,
}: {
  guardrails: GuardrailsData;
  spans: TimelineSpan[];
  layout: Layout;
  selected: TimelineSpan | null;
  selectedConsultKey: string | null;
  onSelect: (key: string) => void;
  onSelectConsult?: (key: string | null) => void;
  view: { a: number; b: number } | null;
  profileName: string | null;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const xToTime = useMemo(() => makeXToTime(spans), [spans]);
  const { consults, labels } = guardrails;
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const failed = consults.filter((c) => c.outcome !== "answered").length;

  const fractionAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return {
      f: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      px: rect.width,
    };
  };
  /** A check within a few pixels wins; otherwise the nearest row's bar. */
  const nearestAt = (
    f: number,
    px: number,
  ):
    | { type: "consult"; consult: MockConsult }
    | { type: "span"; span: TimelineSpan }
    | null => {
    let bestConsult: MockConsult | null = null;
    let consultDistance = Number.POSITIVE_INFINITY;
    for (const consult of consults) {
      const d = Math.abs(consult.x + consult.w / 2 - f);
      if (d < consultDistance) {
        consultDistance = d;
        bestConsult = consult;
      }
    }
    if (bestConsult && consultDistance * px <= 5) {
      return { type: "consult", consult: bestConsult };
    }
    let bestSpan: TimelineSpan | null = null;
    let spanDistance = Number.POSITIVE_INFINITY;
    for (const span of spans) {
      const d =
        f < span.x ? span.x - f : f > span.x + span.w ? f - span.x - span.w : 0;
      if (d < spanDistance) {
        spanDistance = d;
        bestSpan = span;
      }
    }
    return bestSpan ? { type: "span", span: bestSpan } : null;
  };

  const hovered = hover === null ? null : hover;
  const hoverTime = hovered === null ? null : xToTime(hovered);
  const hoverLabel = hoverTime === null ? null : guardrails.labelAt(hoverTime);
  const hoverTarget =
    hovered === null
      ? null
      : nearestAt(hovered, trackRef.current?.offsetWidth ?? 600);
  const restLabel = selected
    ? guardrails.labelAt(selected.start)
    : labels[labels.length - 1];

  const onTrackClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const at = fractionAt(event.clientX);
    if (!at) return;
    const target = nearestAt(at.f, at.px);
    if (!target) return;
    if (target.type === "consult") onSelectConsult?.(target.consult.key);
    else onSelect(target.span.key);
  };

  // Plain ticks first, then flagged ones, then the open one, so the ones
  // that matter paint on top.
  const orderedConsults = [...consults].sort(
    (a, b) =>
      consultRank(a, selectedConsultKey) - consultRank(b, selectedConsultKey),
  );

  return (
    <div
      className={cn(
        "hidden h-8 border-b bg-card text-[11px] lg:grid",
        GRIDS[layout],
      )}
    >
      {/* Readout */}
      <div className="flex min-w-0 flex-col justify-center gap-px pr-3 pl-4 leading-4">
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          Label timeline
          <span className="inline-flex items-center gap-1 font-normal text-muted-foreground/70">
            <MousePointerClick className="size-3" aria-hidden="true" />
            click to jump
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1 truncate text-muted-foreground tabular-nums">
          {hoverTime !== null && hoverLabel ? (
            <>
              <span className="shrink-0">
                {formatDate({
                  date: new Date(hoverTime).toISOString(),
                  dateFormat: "HH:mm:ss",
                })}
              </span>
              <span aria-hidden="true" className="text-muted-foreground/40">
                ·
              </span>
              <LabelWords label={hoverLabel} />
            </>
          ) : (
            <>
              <span className="shrink-0">
                {selected ? "At selection" : "Latest"}
              </span>
              <span aria-hidden="true" className="text-muted-foreground/40">
                ·
              </span>
              <LabelWords label={restLabel} />
            </>
          )}
        </span>
      </div>

      {/* Track */}
      <div
        ref={trackRef}
        role="presentation"
        onClick={onTrackClick}
        onPointerMove={(event) =>
          setHover(fractionAt(event.clientX)?.f ?? null)
        }
        onPointerLeave={() => setHover(null)}
        className="relative mx-3 cursor-pointer"
      >
        {labels.map((segment, index) => {
          const prev = index > 0 ? labels[index - 1] : null;
          const tone = TRUST_TONE[segment.trust];
          const causeKey = segment.cause?.toolCallKey ?? null;
          const causeConsult = segment.cause?.consultKey ?? null;
          const causeSelected =
            (causeKey !== null && selected?.key === causeKey) ||
            (causeConsult !== null && selectedConsultKey === causeConsult);
          return (
            <div
              key={`segment-${segment.start}`}
              className={cn(
                "pointer-events-none absolute inset-y-0",
                tone.soft,
              )}
              style={{
                left: `${segment.x * 100}%`,
                width: `${segment.w * 100}%`,
              }}
            >
              {/* Audience lane along the bottom edge. */}
              <span
                aria-hidden="true"
                className={cn(
                  "absolute inset-x-0 bottom-0 h-[2px]",
                  AUDIENCE_TONE[segment.audience].bar,
                )}
              />
              {prev ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute inset-y-0 left-0 w-[2px] -translate-x-1/2",
                    tone.bar,
                  )}
                />
              ) : null}
              <div className="absolute top-[2px] left-0 flex h-[18px] w-full min-w-0 items-center gap-1.5 pl-1.5">
                {prev && segment.cause ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          if (causeKey) onSelect(causeKey);
                          else if (causeConsult)
                            onSelectConsult?.(causeConsult);
                        }}
                        className={cn(
                          "pointer-events-auto relative z-20 inline-flex h-[18px] shrink-0 cursor-pointer items-center gap-1 rounded-[5px] border bg-card px-1.5 text-[10.5px] font-medium whitespace-nowrap shadow-xs transition-colors outline-none hover:border-foreground/30 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
                          causeSelected &&
                            "border-primary ring-1 ring-primary/40",
                        )}
                      >
                        <ChangeWords prev={prev} segment={segment} />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-72">
                      <p className="font-medium">{segment.cause.summary}</p>
                      <p className="opacity-80">
                        {segment.cause.toolName
                          ? `Caused by ${segment.cause.toolName}. Click to select it.`
                          : "No tool call caused this."}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}
                <span
                  className={cn(
                    "min-w-0 truncate text-[11px] font-medium",
                    tone.text,
                  )}
                >
                  {TRUST_TONE[segment.trust].label} ·{" "}
                  {AUDIENCE_TONE[segment.audience].label}
                </span>
              </div>
            </div>
          );
        })}

        {/* Rows in view */}
        {view ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-px rounded-[3px] border border-foreground/30 bg-foreground/[0.04]"
            style={{
              left: `${view.a * 100}%`,
              width: `max(4px, ${(view.b - view.a) * 100}%)`,
            }}
          />
        ) : null}
        {selected ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 border-x border-dashed border-primary/70"
            style={{
              left: `${selected.x * 100}%`,
              width: `max(2px, ${selected.w * 100}%)`,
            }}
          />
        ) : null}
        {hovered !== null ? (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 z-30 w-px bg-foreground/60"
            style={{ left: `${hovered * 100}%` }}
          />
        ) : null}

        {/* Checks */}
        {orderedConsults.map((consult) => {
          const open = consult.key === selectedConsultKey;
          const flagged =
            consult.decision === "blocked" || consult.outcome !== "answered";
          return (
            <Tooltip key={consult.key}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${consult.externalName}, ${ROLE_LABEL[consult.role]}, ${DECISION_TONE[consult.decision].label}${consult.toolName ? ` for ${consult.toolName}` : ""}`}
                  aria-pressed={open}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelectConsult?.(consult.key);
                  }}
                  className={cn(
                    "group/tick absolute bottom-0 z-10 flex h-5 w-5 -translate-x-1/2 cursor-pointer items-end justify-center rounded-[4px] pb-[4px] outline-none hover:z-20 hover:bg-foreground/10 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring/60",
                    open && "z-20 bg-primary/15 ring-1 ring-primary",
                  )}
                  style={{ left: `${(consult.x + consult.w / 2) * 100}%` }}
                >
                  {flagged && !open ? (
                    <DecisionIcon consult={consult} className="size-3" />
                  ) : (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "w-[2px] rounded-full transition-[height]",
                        open
                          ? "h-3 bg-primary"
                          : "h-2 bg-foreground/45 group-hover/tick:h-3 group-hover/tick:bg-foreground/80",
                      )}
                    />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-72">
                <ConsultSummary consult={consult} />
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>

      {/* What a click selects, or the checks' totals */}
      <div
        className={cn(
          "flex min-w-0 items-center justify-end gap-1.5 pr-4 text-muted-foreground tabular-nums",
          layout === "trace" && "col-span-2",
        )}
      >
        {hoverTarget ? (
          <span className="flex min-w-0 items-center gap-1 text-foreground">
            <ArrowRight className="size-3 shrink-0" aria-hidden="true" />
            {hoverTarget.type === "consult" ? (
              <>
                <DecisionIcon
                  consult={hoverTarget.consult}
                  className="size-3"
                />
                <span className="truncate font-mono">
                  {hoverTarget.consult.externalName}
                </span>
              </>
            ) : (
              <span className="truncate font-mono">
                {spanName(hoverTarget.span, profileName)}
              </span>
            )}
          </span>
        ) : (
          <span className="truncate">
            {consults.length} checks
            {blocked > 0 ? (
              <span className="text-rose-700 dark:text-rose-300">
                {" "}
                · {blocked} blocked
              </span>
            ) : null}
            {failed > 0 ? (
              <span className="text-amber-700 dark:text-amber-300">
                {" "}
                · {failed} no answer
              </span>
            ) : null}
          </span>
        )}
      </div>
    </div>
  );
}

/** Phones: the key to the gutter's two lanes, and the label at the selection. */
function PhoneLabelBar({
  guardrails,
  selected,
  changes,
}: {
  guardrails: GuardrailsData;
  selected: TimelineSpan | null;
  changes: number;
}) {
  const label = selected
    ? guardrails.labelAt(selected.start)
    : guardrails.labels[guardrails.labels.length - 1];
  return (
    <div className="flex h-8 items-center gap-3 border-b bg-muted/40 px-4 text-[11px] whitespace-nowrap text-muted-foreground lg:hidden">
      <span className="flex shrink-0 items-center gap-1.5">
        <span
          aria-hidden="true"
          className={cn(
            "h-3 w-[3px] rounded-full",
            TRUST_TONE[label.trust].bar,
          )}
        />
        Trust
        <span
          aria-hidden="true"
          className={cn(
            "ml-1 h-3 w-[3px] rounded-full",
            AUDIENCE_TONE[label.audience].bar,
          )}
        />
        Audience
      </span>
      <span className="ml-auto flex min-w-0 items-center gap-1 truncate">
        <span className="shrink-0">{selected ? "Selected" : "Latest"}:</span>
        <LabelWords label={label} />
        {changes > 0 ? (
          <span className="shrink-0 text-muted-foreground/70">
            · {changes} {changes === 1 ? "change" : "changes"}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Phones: a line above the first row under a new label, saying what changed. */
function PhoneChangeBanner({
  segment,
  prev,
  onSelect,
  onSelectConsult,
}: {
  segment: LabelSegment;
  prev: LabelState;
  onSelect: (key: string) => void;
  onSelectConsult?: (key: string | null) => void;
}) {
  const cause = segment.cause;
  const target = cause?.toolCallKey ?? null;
  const consult = cause?.consultKey ?? null;
  return (
    <li className="relative flex h-7 items-center border-b border-border/40 bg-muted/30 pr-4 pl-[18px] lg:hidden">
      <span aria-hidden="true" className="absolute inset-y-0 left-0 w-4">
        <span
          className={cn(
            "absolute top-1/2 bottom-0 left-[4px] w-[3px]",
            TRUST_TONE[segment.trust].bar,
          )}
        />
        <span
          className={cn(
            "absolute top-1/2 bottom-0 left-[9px] w-[3px]",
            AUDIENCE_TONE[segment.audience].bar,
          )}
        />
        <span
          className={cn(
            "absolute top-1/2 left-[2px] size-[12px] -translate-y-1/2 rounded-full border-2 border-card",
            TRUST_TONE[segment.trust].bar,
          )}
        />
      </span>
      <button
        type="button"
        disabled={!target && !consult}
        onClick={() => {
          if (target) onSelect(target);
          else if (consult) onSelectConsult?.(consult);
        }}
        className="-mx-1 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1 text-[11px] outline-none enabled:cursor-pointer enabled:hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        <span className="shrink-0 font-medium">
          <ChangeWords prev={prev} segment={segment} />
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {cause?.toolName && target
            ? `after ${cause.toolName}`
            : (cause?.summary ?? "")}
        </span>
      </button>
    </li>
  );
}

/** Phones: a row's two label lanes, trust then audience. */
function LabelGutter({ label }: { label: LabelState }) {
  return (
    <span
      className="relative lg:hidden"
      title={`${TRUST_TONE[label.trust].label} · ${AUDIENCE_TONE[label.audience].label}`}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute -top-px -bottom-px left-[4px] w-[3px]",
          TRUST_TONE[label.trust].bar,
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          "absolute -top-px -bottom-px left-[9px] w-[3px]",
          AUDIENCE_TONE[label.audience].bar,
        )}
      />
    </span>
  );
}

/**
 * After a guarded tool's name: its checks. A click opens the most telling
 * one below (blocked, then unanswered, then the first); clicking again steps
 * to the next.
 */
function GuardChip({
  consults,
  rowSelected,
  selectedConsultKey,
  onSelectConsult,
}: {
  consults: MockConsult[];
  rowSelected: boolean;
  selectedConsultKey: string | null;
  onSelectConsult: (key: string | null) => void;
}) {
  const openIndex = consults.findIndex((c) => c.key === selectedConsultKey);
  const lead = [...consults].sort((a, b) => severity(b) - severity(a))[0];
  const blocked = consults.some((c) => c.decision === "blocked");
  const activate = () => {
    const next =
      openIndex >= 0 ? consults[(openIndex + 1) % consults.length] : lead;
    onSelectConsult(next.key);
  };
  const open = openIndex >= 0;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* biome-ignore lint/a11y/useSemanticElements: sits inside the row's button */}
        <span
          role="button"
          tabIndex={rowSelected ? 0 : -1}
          aria-label={`${consults.length} guardrail ${consults.length === 1 ? "check" : "checks"}${blocked ? ", blocked" : ""}; open in details`}
          aria-pressed={open}
          onClick={(event) => {
            event.stopPropagation();
            activate();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            activate();
          }}
          className={cn(
            "-my-0.5 inline-flex h-5 min-w-5 shrink-0 cursor-pointer items-center justify-center gap-0.5 rounded-[5px] border px-1 text-[10px] leading-none font-medium tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
            open
              ? "border-primary bg-primary/10 text-primary ring-1 ring-primary/40"
              : blocked
                ? "border-rose-500/40 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
                : "border-border bg-card text-muted-foreground hover:border-foreground/30 hover:bg-muted hover:text-foreground",
          )}
        >
          <DecisionIcon
            consult={open ? consults[openIndex] : lead}
            className={cn("size-3", open && "text-primary")}
          />
          {open && consults.length > 1
            ? `${openIndex + 1}/${consults.length}`
            : blocked
              ? "Blocked"
              : consults.length > 1
                ? consults.length
                : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-80">
        <p className="mb-1 font-medium">
          Guardrail {consults.length === 1 ? "check" : "checks"} · click to open
          {consults.length > 1 ? ", again for the next" : ""}
        </p>
        <ul className="space-y-0.5">
          {consults.map((c) => (
            <li key={c.key} className="flex items-center gap-1.5">
              <span className="font-mono">{c.externalName}</span>
              <span className="opacity-70">
                {c.beforeCall ? "before" : "after"} ·{" "}
                {DECISION_TONE[c.decision].label}
              </span>
            </li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

/** A tool call's checks on its own track: gates before the bar, checks after. */
function ConsultMarks({
  consults,
  selectedConsultKey,
}: {
  consults: MockConsult[];
  selectedConsultKey: string | null;
}) {
  return (
    <>
      {consults.map((c) => (
        <span
          key={c.key}
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full",
            c.key === selectedConsultKey
              ? "h-[5px] bg-primary"
              : c.decision === "blocked"
                ? "bg-rose-500 dark:bg-rose-400"
                : c.outcome !== "answered"
                  ? "bg-amber-500 dark:bg-amber-400"
                  : "bg-foreground/30",
          )}
          style={{
            left: `${c.x * 100}%`,
            width: `max(3px, ${c.w * 100}%)`,
          }}
        />
      ))}
    </>
  );
}

/** "Trust → Suspicious", "Audience → Internal", in words. */
function ChangeWords({
  prev,
  segment,
}: {
  prev: LabelState;
  segment: LabelSegment;
}) {
  const parts: { field: string; to: string; tone: string }[] = [];
  if (prev.trust !== segment.trust) {
    parts.push({
      field: "Trust",
      to: TRUST_TONE[segment.trust].label,
      tone: TRUST_TONE[segment.trust].text,
    });
  }
  if (prev.audience !== segment.audience) {
    parts.push({
      field: "Audience",
      to: AUDIENCE_TONE[segment.audience].label,
      tone: AUDIENCE_TONE[segment.audience].text,
    });
  }
  return (
    <span className="inline-flex items-center gap-1">
      {segment.cause?.kind === "reset" ? (
        <span className="text-muted-foreground">Reset:</span>
      ) : null}
      {parts.map((part, index) => (
        <span key={part.field} className="inline-flex items-center gap-0.5">
          {index > 0 ? (
            <span className="mr-0.5 text-muted-foreground/60">,</span>
          ) : null}
          <span className="text-muted-foreground">{part.field}</span>
          <ArrowRight
            className="size-2.5 text-muted-foreground/70"
            aria-label="changed to"
          />
          <span className={part.tone}>{part.to}</span>
        </span>
      ))}
    </span>
  );
}

function LabelWords({ label }: { label: LabelState }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 truncate font-medium">
      <span className={TRUST_TONE[label.trust].text}>
        {TRUST_TONE[label.trust].label}
      </span>
      <span aria-hidden="true" className="text-muted-foreground/40">
        ·
      </span>
      <span className={AUDIENCE_TONE[label.audience].text}>
        {AUDIENCE_TONE[label.audience].label}
      </span>
    </span>
  );
}

function ConsultSummary({ consult }: { consult: MockConsult }) {
  return (
    <div className="space-y-0.5">
      <p className="flex items-center gap-1.5 font-medium">
        <span className="font-mono">{consult.externalName}</span>
        <span className="opacity-70">{ROLE_LABEL[consult.role]}</span>
        <span>· {DECISION_TONE[consult.decision].label}</span>
      </p>
      {consult.toolName ? (
        <p className="opacity-80">
          {consult.beforeCall ? "Before" : "On the result of"}{" "}
          <span className="font-mono">{consult.toolName}</span> ·{" "}
          {formatLatency(consult.durationMs)}
        </p>
      ) : null}
      <p className="opacity-80">{consult.answer}</p>
      <p className="opacity-60">Click to open the check below</p>
    </div>
  );
}

function severity(consult: MockConsult): number {
  if (consult.decision === "blocked") return 2;
  if (consult.outcome !== "answered") return 1;
  return 0;
}

function consultRank(consult: MockConsult, openKey: string | null): number {
  if (consult.key === openKey) return 3;
  return severity(consult) > 0 ? 1 : 0;
}

function spanName(span: TimelineSpan, profileName: string | null): string {
  if (span.type === "request") return requestLabel(span.row, profileName);
  const content = readMcpToolCall(span.call);
  return content.toolName ?? content.method;
}

/** Inverts the axis from the spans' own edges, idle folds included. */
function makeXToTime(spans: TimelineSpan[]): (x: number) => number {
  const points = spans
    .flatMap((s) => [
      { x: s.x, t: s.start },
      { x: s.x + s.w, t: s.end },
    ])
    .sort((a, b) => a.x - b.x || a.t - b.t);
  return (x) => {
    if (points.length === 0) return 0;
    if (x <= points[0].x) return points[0].t;
    const last = points[points.length - 1];
    if (x >= last.x) return last.t;
    let lo = 0;
    let hi = points.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (points[mid].x <= x) lo = mid;
      else hi = mid;
    }
    const a = points[lo];
    const b = points[hi];
    if (b.x === a.x) return a.t;
    return a.t + ((x - a.x) / (b.x - a.x)) * (b.t - a.t);
  };
}
