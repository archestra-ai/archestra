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

import {
  ArrowRight,
  ChevronRight,
  CornerDownRight,
  MessageSquareText,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
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

  // OpenAPPA: consults grouped under the tool call they ran for, and the
  // session label each row ran under. Null when guardrails are off, which
  // leaves every row exactly as production draws it.
  const guard = useMemo(
    () => buildGuardIndex(guardrails, spans),
    [guardrails, spans],
  );
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [activeConsult, setActiveConsult] = useState<string | null>(null);
  const toggleChecks = (key: string, open?: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open ?? !next.has(key)) next.add(key);
      else next.delete(key);
      return next;
    });
  const allExpanded =
    !!guard &&
    guard.byTool.size > 0 &&
    [...guard.byTool.keys()].every((key) => expanded.has(key));

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
    // Right opens a guarded call's checks, Left folds them.
    if (
      (event.key === "ArrowRight" || event.key === "ArrowLeft") &&
      selected &&
      guard?.byTool.has(selected.key)
    ) {
      event.preventDefault();
      toggleChecks(selected.key, event.key === "ArrowRight");
      return;
    }
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
            {guard ? (
              <GuardLegend
                total={guard.total}
                blocked={guard.blocked}
                allExpanded={allExpanded}
                onToggleAll={() =>
                  setExpanded(
                    allExpanded ? new Set() : new Set(guard.byTool.keys()),
                  )
                }
              />
            ) : null}
          </ul>
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground xl:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="ml-1">to step · {openHint}</span>
            {guard ? (
              <>
                <Kbd className="ml-2">→</Kbd>
                <span className="ml-1">checks</span>
              </>
            ) : null}
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
              {/* The session label along the axis: a 2px hairline under
                  the ticks, the time-true twin of the left rail. */}
              {guard?.labels.map((seg) => (
                <span
                  key={`axis-label-${seg.start}`}
                  aria-hidden="true"
                  className={cn(
                    "absolute bottom-0 hidden h-[2px] opacity-70 lg:block",
                    TRUST_TONE[seg.trust].bar,
                    seg.audience !== "public" && DASH_X,
                  )}
                  style={{ left: `${seg.x * 100}%`, width: `${seg.w * 100}%` }}
                />
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
                  const consults =
                    span.type === "tool"
                      ? guard?.byTool.get(span.key)
                      : undefined;
                  const open = !!consults && expanded.has(span.key);
                  const rowGuard: RowGuard | undefined = guard
                    ? {
                        rail: (
                          <LabelRail
                            segment={guard.labels[guard.segmentAt(span.start)]}
                            change={guard.changeAt.has(span.key)}
                          />
                        ),
                        chip: consults ? (
                          <ChecksChip
                            consults={consults}
                            expanded={open}
                            onToggle={() => toggleChecks(span.key)}
                          />
                        ) : null,
                        expanded: consults ? open : undefined,
                        trackUnder:
                          consults && !open ? (
                            <ConsultTicks consults={consults} />
                          ) : null,
                      }
                    : undefined;
                  const rowProps = {
                    guard: rowGuard,
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
                    <Fragment key={span.key}>
                      <ToolCallRow
                        span={span}
                        display={serverDisplayByName.get(
                          span.call.mcpServerName,
                        )}
                        {...rowProps}
                      />
                      {guard && consults && open
                        ? consults.map((consult) => (
                            <ConsultRow
                              key={consult.key}
                              consult={consult}
                              layout={layout}
                              segment={
                                guard.labels[guard.segmentAt(consult.start)]
                              }
                              active={activeConsult === consult.key}
                              onActivate={() =>
                                setActiveConsult((prev) =>
                                  prev === consult.key ? null : consult.key,
                                )
                              }
                            />
                          ))
                        : null}
                    </Fragment>
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
              guard={guard ? { total: guard.total, blocked: guard.blocked } : null}
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
  guard: { total: number; blocked: number } | null;
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
  if (guard && guard.total > 0) {
    parts.push({
      key: "checks",
      text: (
        <span>
          {guard.total.toLocaleString()} guardrail{" "}
          {guard.total === 1 ? "check" : "checks"}
          {guard.blocked > 0 ? (
            <span className={DECISION_TONE.blocked.text}>
              , {guard.blocked} blocked
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

/** What OpenAPPA adds to a trace row; absent when guardrails are off. */
type RowGuard = {
  /** The session label rail in the row's left gutter. */
  rail: ReactNode;
  /** "2 checks" disclosure beside a guarded tool call's name. */
  chip: ReactNode;
  /** Set on guarded rows only, so the others carry no aria-expanded. */
  expanded: boolean | undefined;
  /** Collapsed consults, drawn as hairlines on the call's track. */
  trackUnder: ReactNode;
};

type RowProps = {
  guard?: RowGuard;
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
  guard,
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
    <li className="relative">
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        aria-expanded={guard?.expanded}
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
              {guard?.chip}
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
          {guard?.trackUnder}
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
      {guard?.rail}
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
// OpenAPPA (guardrails) pieces
// ============================================================================

/** A narrower-than-public audience dashes the label: vertically on the rail. */
const DASH_Y =
  "[mask-image:repeating-linear-gradient(to_bottom,#000_0_2.5px,transparent_2.5px_4px)]";
/** ...and horizontally on the axis hairline. */
const DASH_X =
  "[mask-image:repeating-linear-gradient(to_right,#000_0_3px,transparent_3px_5px)]";

type GuardIndex = {
  /** Consults by the span key of the tool call they ran for. */
  byTool: Map<string, MockConsult[]>;
  total: number;
  blocked: number;
  labels: LabelSegment[];
  /** Index into `labels` of the segment in force at a time. */
  segmentAt: (ms: number) => number;
  /** The first row each label change lands on, to the segment it opens. */
  changeAt: Map<string, number>;
};

function buildGuardIndex(
  guardrails: GuardrailsData | null,
  spans: TimelineSpan[],
): GuardIndex | null {
  if (!guardrails || guardrails.labels.length === 0) return null;
  const keys = new Set(spans.map((span) => span.key));
  const byTool = new Map<string, MockConsult[]>();
  let total = 0;
  let blocked = 0;
  for (const consult of guardrails.consults) {
    if (!consult.toolCallKey || !keys.has(consult.toolCallKey)) continue;
    const list = byTool.get(consult.toolCallKey) ?? [];
    list.push(consult);
    byTool.set(consult.toolCallKey, list);
    total++;
    if (consult.decision === "blocked") blocked++;
  }
  const { labels } = guardrails;
  const segmentAt = (ms: number) => {
    const hit = labels.findIndex((seg) => ms >= seg.start && ms < seg.end);
    if (hit >= 0) return hit;
    return ms < labels[0].start ? 0 : labels.length - 1;
  };
  const changeAt = new Map<string, number>();
  labels.forEach((seg, index) => {
    if (index === 0) return;
    const row = spans.find((span) => span.start >= seg.start);
    if (row) changeAt.set(row.key, index);
  });
  return { byTool, total, blocked, labels, segmentAt, changeAt };
}

function labelText(seg: LabelSegment) {
  return `${TRUST_TONE[seg.trust].label}, ${AUDIENCE_TONE[seg.audience].label.toLowerCase()} audience`;
}

/**
 * The session label beside one row: a 2px rail in the gutter left of the kind
 * rail, coloured by trust and dashed once the audience is narrower than
 * public. Rows abut, so the rails read as one line down the list; a small
 * knot marks the row where the label changed.
 */
function LabelRail({
  segment,
  change,
}: {
  segment: LabelSegment;
  change: boolean;
}) {
  const tone = TRUST_TONE[segment.trust];
  const narrowed = segment.audience !== "public";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={`Session label: ${labelText(segment)}`}
          className="group/rail absolute inset-y-0 left-0 z-[1] w-3"
        >
          <span
            className={cn(
              "absolute inset-y-0 left-[6px] w-[2px] opacity-75 transition-opacity group-hover/rail:opacity-100",
              tone.bar,
              narrowed && DASH_Y,
            )}
          />
          {change ? (
            <span
              className={cn(
                "absolute top-0 left-[7px] size-[7px] -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card",
                tone.bar,
              )}
            />
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        align="start"
        className="max-w-72 space-y-1 text-left"
      >
        <p className="flex items-center gap-1.5 font-medium">
          <span className={tone.text}>{tone.label}</span>
          <span className="text-muted-foreground/60">/</span>
          <span className={AUDIENCE_TONE[segment.audience].text}>
            {AUDIENCE_TONE[segment.audience].label}
          </span>
        </p>
        <p className="text-muted-foreground">
          {segment.cause?.summary ?? "Session start: trusted and public"}
        </p>
        <p className="text-[11px] text-muted-foreground/80 tabular-nums">
          {segment.cause
            ? `Since ${formatDate({ date: new Date(segment.start).toISOString(), dateFormat: "HH:mm:ss" })}`
            : null}
          {segment.cause?.toolName ? (
            <>
              {" after "}
              <span className="font-mono">{segment.cause.toolName}</span>
            </>
          ) : null}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The guarded call's disclosure: shield, count, chevron. Rose if any blocked. */
function ChecksChip({
  consults,
  expanded,
  onToggle,
}: {
  consults: MockConsult[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const blocked = consults.some((c) => c.decision === "blocked");
  const degraded = consults.some((c) => c.outcome !== "answered");
  const Icon = blocked ? ShieldX : degraded ? ShieldAlert : ShieldCheck;
  const n = consults.length;
  return (
    // Inside the row's button, so a span: clicks stop here instead of
    // selecting the row; the keyboard path is → / ← on the selected row.
    <span
      role="button"
      tabIndex={-1}
      aria-expanded={expanded}
      aria-label={`${n} guardrail ${n === 1 ? "check" : "checks"}${blocked ? ", blocked" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center gap-[3px] rounded-sm pr-0.5 pl-1 font-sans text-[10px] leading-4 font-medium tabular-nums transition-colors",
        blocked
          ? cn(CONSULT_KIND.chip, "hover:bg-rose-500/20")
          : "bg-muted text-muted-foreground hover:bg-foreground/10 hover:text-foreground",
        expanded && !blocked && "bg-foreground/10 text-foreground",
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      <span>
        {n} {n === 1 ? "check" : "checks"}
      </span>
      <ChevronRight
        className={cn(
          "size-2.5 opacity-70 transition-transform duration-150",
          expanded && "rotate-90",
        )}
        aria-hidden="true"
      />
    </span>
  );
}

/** Folded consults still show where they ran: hairlines beside the bar. */
function ConsultTicks({ consults }: { consults: MockConsult[] }) {
  return consults.map((consult) => (
    <span
      key={consult.key}
      aria-hidden="true"
      className={cn(
        "absolute top-1/2 h-px -translate-y-1/2",
        consult.decision === "blocked"
          ? CONSULT_KIND.bar
          : "bg-muted-foreground/50",
      )}
      style={{
        left: `${consult.x * 100}%`,
        width: `max(2px, ${consult.w * 100}%)`,
      }}
    />
  ));
}

function consultBar(consult: MockConsult) {
  if (consult.decision === "blocked") return CONSULT_KIND.bar;
  if (consult.outcome !== "answered")
    return "bg-amber-500/70 dark:bg-amber-400/70";
  return "bg-muted-foreground/45";
}

/**
 * One consult, indented under its tool call: shorter and quieter than a
 * span row, on the same grid and axis. Not part of ↑↓ stepping; a click
 * marks it, the tooltip carries the answer.
 */
function ConsultRow({
  consult,
  layout,
  segment,
  active,
  onActivate,
}: {
  consult: MockConsult;
  layout: Layout;
  segment: LabelSegment;
  active: boolean;
  onActivate: () => void;
}) {
  const decision = DECISION_TONE[consult.decision];
  const blocked = consult.decision === "blocked";
  const failed = consult.outcome !== "answered";
  const latency = formatLatency(consult.durationMs);
  const placement = placeLatency(consult);
  const Icon = blocked ? ShieldX : failed ? ShieldAlert : ShieldCheck;
  const outcomeText =
    consult.outcome === "timeout"
      ? "Timed out"
      : consult.outcome === "non_success"
        ? "Failed"
        : null;
  return (
    <li className="relative">
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            tabIndex={-1}
            onClick={onActivate}
            aria-pressed={active}
            aria-label={`${ROLE_LABEL[consult.role]} ${consult.externalName} for ${consult.toolName ?? "tool call"}: ${decision.label}, ${latency}`}
            className={cn(
              "grid h-8 w-full border-b border-border/40 bg-muted/30 text-left text-[11px] outline-none transition-colors duration-100 lg:h-7",
              GRIDS[layout],
              active
                ? "bg-muted/80 shadow-[inset_2px_0_0_var(--color-muted-foreground)]"
                : "hover:bg-muted/60",
            )}
          >
            <span className="flex min-w-0 items-center pr-3 pl-4">
              {/* The parent's kind rail continues as a hairline. */}
              <span
                aria-hidden="true"
                className="flex w-[3px] shrink-0 justify-center self-stretch"
              >
                <span className="w-px bg-border" />
              </span>
              <Icon
                aria-hidden="true"
                className={cn(
                  "ml-[26px] size-3 shrink-0",
                  blocked
                    ? decision.text
                    : failed
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground",
                )}
              />
              <span className="ml-1.5 min-w-0 truncate font-mono font-medium text-foreground/85">
                {consult.externalName}
              </span>
              <span className="ml-1.5 shrink-0 text-muted-foreground/70">
                {ROLE_LABEL[consult.role].toLowerCase()}
              </span>
            </span>

            <span className="relative mx-2 block lg:mx-3">
              <span
                className={cn(
                  "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                  consultBar(consult),
                  active && "ring-2 ring-muted-foreground/30 ring-offset-1 ring-offset-card",
                )}
                style={{
                  left: `${consult.x * 100}%`,
                  width: `max(4px, ${consult.w * 100}%)`,
                }}
              />
              <span
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[10.5px] whitespace-nowrap text-muted-foreground/80 tabular-nums lg:block",
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

            {layout === "trace" ? <span className="hidden lg:block" /> : null}

            <span
              className={cn(
                "flex items-center justify-end pr-4 font-medium",
                outcomeText
                  ? "text-amber-700 dark:text-amber-300"
                  : blocked
                    ? decision.text
                    : "text-muted-foreground",
              )}
            >
              {outcomeText ?? decision.label}
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          alignOffset={44}
          sideOffset={2}
          className="w-72 space-y-1.5 text-left"
        >
          <p className="flex items-center justify-between gap-3">
            <span className="font-medium">
              {ROLE_LABEL[consult.role]}
              <span className="font-normal text-muted-foreground">
                {consult.beforeCall ? " before the call" : " on the result"}
              </span>
            </span>
            <span
              className={cn(
                "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                decision.chip,
              )}
            >
              {decision.label}
            </span>
          </p>
          <p className="text-foreground/90">{consult.answer}</p>
          <p className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground tabular-nums">
            <span className="min-w-0 truncate font-mono">
              {consult.externalName}
              <span className="font-sans"> via {consult.backend}</span>
            </span>
            <span className="shrink-0">
              {outcomeText ? `${outcomeText}, ` : ""}
              {latency}
            </span>
          </p>
          <p className="flex items-center gap-1.5 border-t pt-1.5 text-[11px] text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                "h-3 w-[2px] rounded-full",
                TRUST_TONE[segment.trust].bar,
                segment.audience !== "public" && DASH_Y,
              )}
            />
            Label {labelText(segment).toLowerCase()}
          </p>
        </TooltipContent>
      </Tooltip>
      <LabelRail segment={segment} change={false} />
    </li>
  );
}

/** The toolbar's key for what guardrails add, after the four span kinds. */
function GuardLegend({
  total,
  blocked,
  allExpanded,
  onToggleAll,
}: {
  total: number;
  blocked: number;
  allExpanded: boolean;
  onToggleAll: () => void;
}) {
  return (
    <>
      <li aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
      <li className="inline-flex">
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton
              onClick={onToggleAll}
              aria-pressed={allExpanded}
              disabled={total === 0}
              className="-mx-1 inline-flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:text-foreground disabled:opacity-40"
            >
              <ShieldCheck
                className={cn(
                  "size-3",
                  blocked > 0 && DECISION_TONE.blocked.text,
                )}
                aria-hidden="true"
              />
              <span>Checks</span>
              <span className="text-muted-foreground/70 tabular-nums">
                {total}
              </span>
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 text-left">
            Guardrail consults, folded under the tool call they gated or
            labelled.
            {blocked > 0 ? ` ${blocked} blocked.` : ""}{" "}
            {allExpanded ? "Click to fold all." : "Click to unfold all."}
          </TooltipContent>
        </Tooltip>
      </li>
      <li className="inline-flex max-lg:hidden">
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex cursor-default items-center gap-1.5">
              <span aria-hidden="true" className="inline-flex gap-[2px]">
                <span className={cn("h-3 w-[2px]", TRUST_TONE.trusted.bar)} />
                <span
                  className={cn("h-3 w-[2px]", TRUST_TONE.suspicious.bar, DASH_Y)}
                />
              </span>
              <span>Label</span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-64 space-y-1 text-left">
            <p>Session label, on the left edge of each row.</p>
            <p className="text-muted-foreground">
              <span className={TRUST_TONE.trusted.text}>Green</span> trusted,{" "}
              <span className={TRUST_TONE.suspicious.text}>rose</span>{" "}
              suspicious. Dashed once the audience is narrower than public.
            </p>
          </TooltipContent>
        </Tooltip>
      </li>
    </>
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
