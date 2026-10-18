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
} from "./guardrails-mock";

import {
  CornerDownRight,
  Lock,
  MessageSquareText,
  RotateCcw,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Tag,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
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
  const guards = useMemo(
    () => buildRowGuards(spans, guardrails),
    [spans, guardrails],
  );
  const openConsult = (key: string) => onSelectConsult?.(key);
  // A label change opens the check that caused it when there is one (the
  // annotator's answer is the "why"), else selects the tool call, else the
  // row the change lands on.
  const activateChange = (change: LabelChange) => {
    const { cause } = change;
    if (cause.consultKey && onSelectConsult) onSelectConsult(cause.consultKey);
    else onSelect(cause.toolCallKey ?? change.spanKey);
  };
  const isChangeActive = (change: LabelChange) =>
    (change.cause.consultKey != null &&
      change.cause.consultKey === selectedConsultKey) ||
    (!selectedConsultKey &&
      (change.cause.toolCallKey ?? change.spanKey) === selectedKey);
  const guardCtx: GuardCtx | null = guards
    ? {
        selectedConsultKey,
        openConsult,
        activateChange,
        isChangeActive,
      }
    : null;

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
      {guards && guardCtx ? (
        <GutterLegend guards={guards} ctx={guardCtx} />
      ) : null}
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
            {guards ? (
              <div
                className="flex items-center justify-center border-r border-border/60"
                title="Session label at each row: trust (colour) and audience (stripes)"
              >
                <Tag className="size-3" aria-hidden="true" />
                <span className="sr-only">Session label</span>
              </div>
            ) : null}
            <div
              className={cn(
                "flex items-center gap-1.5",
                guards ? "pl-2.5" : "pl-4",
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

          {loading ? (
            <WaterfallSkeleton
              layout={layout}
              grid={grid}
              gutter={guards != null}
            />
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
                {guards ? <div /> : null}
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
                    grid,
                    guard: guards?.rows.get(span.key) ?? null,
                    guardCtx,
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
            {guards && guardCtx ? (
              <GuardStatus guards={guards} ctx={guardCtx} />
            ) : null}
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
/** The same grids behind a 20px label gutter, on phones and desktop alike. */
const GUARD_GRIDS: Record<Layout, string> = {
  trace:
    "grid-cols-[20px_minmax(0,1fr)_80px_68px] lg:grid-cols-[20px_minmax(232px,296px)_minmax(360px,1fr)_72px_84px]",
  tools:
    "grid-cols-[20px_minmax(0,1fr)_80px_68px] lg:grid-cols-[20px_minmax(232px,296px)_minmax(360px,1fr)_84px]",
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
  grid: string;
  /** This row's label and checks; null without guardrails data. */
  guard: RowGuard | null;
  guardCtx: GuardCtx | null;
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
  grid,
  guard,
  guardCtx,
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
  const tools = layout === "tools";
  const latencyPlacement = placeLatency(span);
  const consults = guard?.consults ?? [];
  const gates = consults.filter((c) => c.beforeCall);
  const results = consults.filter((c) => !c.beforeCall);
  // Result checks sit after the bar unless it runs to the track's end.
  const resultsAfter = span.x + span.w <= 0.88;
  const beforeCount = gates.length + (resultsAfter ? 0 : results.length);
  const afterCount = resultsAfter ? results.length : 0;
  const shield = (consult: MockConsult) =>
    guardCtx ? (
      <ConsultShield
        key={consult.key}
        consult={consult}
        selected={consult.key === guardCtx.selectedConsultKey}
        tabbable={selected}
        onOpen={guardCtx.openConsult}
      />
    ) : null;
  const ariaLabel = guard
    ? `${label}, label ${TRUST_TONE[guard.segment.trust].label} ${AUDIENCE_TONE[guard.segment.audience].label}${
        guard.change
          ? `, label changed: ${guard.change.parts.map((p) => `${p.field} to ${p.to}`).join(", ")}`
          : ""
      }${consults.length > 0 ? `, ${consults.length} guardrail ${consults.length === 1 ? "check" : "checks"}` : ""}`
    : label;
  return (
    <li>
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={ariaLabel}
        className={cn(
          "group grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
          grid,
          selected
            ? cn(
                "bg-primary/[0.07]",
                !guard && "shadow-[inset_2px_0_0_var(--color-primary)]",
              )
            : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {guard && guardCtx ? (
          <GutterCell guard={guard} ctx={guardCtx} />
        ) : null}
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 pr-3",
            guard ? "pl-2.5" : "pl-4",
            guard && selected && "shadow-[inset_2px_0_0_var(--color-primary)]",
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
              {/* Phones: the track is too narrow for checks beside the
                  bar, so they follow the name instead. */}
              {consults.length > 0 ? (
                <span className="-my-1 ml-auto flex shrink-0 items-center gap-0.5 lg:hidden">
                  {consults.map(shield)}
                </span>
              ) : null}
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[11px] leading-4 tabular-nums",
                selected ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              {guard?.change && guardCtx ? (
                <ChangePill
                  change={guard.change}
                  ctx={guardCtx}
                  tabbable={selected}
                />
              ) : null}
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
          {/* Checks on the axis: gates just before the bar, result checks
              just after it. */}
          {beforeCount > 0 ? (
            <span
              className="absolute top-1/2 z-[2] hidden -translate-y-1/2 items-center gap-0.5 lg:flex"
              style={{ right: `calc(${(1 - span.x) * 100}% + 2px)` }}
            >
              {resultsAfter ? null : results.map(shield)}
              {gates.map(shield)}
            </span>
          ) : null}
          {afterCount > 0 ? (
            <span
              className="absolute top-1/2 z-[2] hidden -translate-y-1/2 items-center gap-0.5 lg:flex"
              style={{ left: `calc(${(span.x + span.w) * 100}% + 2px)` }}
            >
              {results.map(shield)}
            </span>
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
                      left: `calc(${(span.x + span.w) * 100}% + ${8 + afterCount * 22}px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + beforeCount * 22}px)`,
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

const SKELETON_PLACEMENTS = [
  [0, 30],
  [8, 12],
  [22, 40],
  [48, 10],
  [60, 25],
  [83, 17],
];

function WaterfallSkeleton({
  layout,
  grid,
  gutter,
}: {
  layout: Layout;
  grid: string;
  gutter: boolean;
}) {
  return (
    <div>
      {SKELETON_PLACEMENTS.map(([x, w]) => (
        <div
          key={x}
          className={cn(
            "grid h-11 items-center border-b border-border/40 lg:h-10",
            grid,
          )}
        >
          {gutter ? <div className="h-full bg-muted/60" /> : null}
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
// Guardrails: the label gutter, label changes and checks (arena)
// ============================================================================

type LabelChange = {
  /** The row the new label first applies to. */
  spanKey: string;
  cause: NonNullable<LabelSegment["cause"]>;
  /** What changed, in words: "Trust → Suspicious", "Audience → Internal". */
  parts: { field: string; to: string }[];
  /** Pill tone, from the most significant part. */
  tone: string;
};

type RowGuard = {
  /** The label in force when the row started. */
  segment: LabelSegment;
  /** Set on the first row under a new label. */
  change: LabelChange | null;
  /** Checks raised for this tool call. */
  consults: MockConsult[];
};

type RowGuards = {
  rows: Map<string, RowGuard>;
  changes: LabelChange[];
  /** Every check on this page, in time order. */
  consults: MockConsult[];
};

type GuardCtx = {
  selectedConsultKey: string | null;
  openConsult: (key: string) => void;
  activateChange: (change: LabelChange) => void;
  isChangeActive: (change: LabelChange) => boolean;
};

function buildRowGuards(
  spans: TimelineSpan[],
  guardrails: GuardrailsData | null,
): RowGuards | null {
  if (!guardrails || guardrails.labels.length === 0) return null;
  const byTool = new Map<string, MockConsult[]>();
  for (const consult of guardrails.consults) {
    if (!consult.toolCallKey) continue;
    const list = byTool.get(consult.toolCallKey) ?? [];
    list.push(consult);
    byTool.set(consult.toolCallKey, list);
  }
  const rows = new Map<string, RowGuard>();
  const changes: LabelChange[] = [];
  const consults: MockConsult[] = [];
  let prev: LabelSegment | null = null;
  for (const span of spans) {
    const segment = segmentAt(guardrails.labels, span.start);
    let change: LabelChange | null = null;
    if (prev && segment !== prev && segment.cause) {
      change = {
        spanKey: span.key,
        cause: segment.cause,
        ...describeChange(prev, segment),
      };
      changes.push(change);
    }
    const checks = byTool.get(span.key) ?? [];
    consults.push(...checks);
    rows.set(span.key, { segment, change, consults: checks });
    prev = segment;
  }
  return { rows, changes, consults };
}

function segmentAt(labels: LabelSegment[], ms: number): LabelSegment {
  let hit = labels[0];
  for (const segment of labels) {
    if (segment.start <= ms) hit = segment;
    else break;
  }
  return hit;
}

function describeChange(
  prev: LabelSegment,
  next: LabelSegment,
): Pick<LabelChange, "parts" | "tone"> {
  if (next.cause?.kind === "reset") {
    return {
      parts: [
        {
          field: "Reset",
          to: `${TRUST_TONE[next.trust].label} · ${AUDIENCE_TONE[next.audience].label}`,
        },
      ],
      tone: RESET_PILL,
    };
  }
  const parts: LabelChange["parts"] = [];
  let tone = RESET_PILL;
  if (prev.audience !== next.audience) {
    parts.push({ field: "Audience", to: AUDIENCE_TONE[next.audience].label });
    tone = AUDIENCE_PILL[next.audience];
  }
  if (prev.trust !== next.trust) {
    parts.unshift({ field: "Trust", to: TRUST_TONE[next.trust].label });
    tone = TRUST_PILL[next.trust];
  }
  return { parts, tone };
}

function changeWords(change: LabelChange): string {
  return change.parts.map((p) => `${p.field} → ${p.to}`).join(", ");
}

function causeHint(change: LabelChange): string {
  const { cause } = change;
  if (cause.consultKey) {
    return `From ${cause.toolName ?? "a tool call"}'s result. Click to open the check that set it.`;
  }
  if (cause.toolCallKey) {
    return `Caused by ${cause.toolName ?? "a tool call"}. Click to select that call.`;
  }
  return "No tool call caused this change.";
}

/**
 * A clickable surface inside a row's button: it handles its own click and
 * keys and keeps them from selecting or opening the row.
 */
function pressable(action: () => void) {
  return {
    role: "button" as const,
    onClick: (event: MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      action();
    },
    onDoubleClick: (event: MouseEvent<HTMLElement>) => event.stopPropagation(),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      action();
    },
  };
}

/**
 * The row's 20px label cell: filled by trust, striped when the audience is
 * narrower than public, and at a change row a marker that opens the cause.
 */
function GutterCell({ guard, ctx }: { guard: RowGuard; ctx: GuardCtx }) {
  const { segment, change } = guard;
  const words = `${TRUST_TONE[segment.trust].label} · ${AUDIENCE_TONE[segment.audience].label}`;
  const Icon = change ? CHANGE_ICON[change.cause.kind] : null;
  return (
    <span
      className={cn(
        "relative z-[1] -mb-px block self-stretch border-r border-border/60",
        GUTTER_FILL[segment.trust],
      )}
      title={change ? undefined : `Label: ${words}`}
    >
      {segment.audience !== "public" ? (
        <span aria-hidden="true" className={cn("absolute inset-0", STRIPES)} />
      ) : null}
      {change && Icon ? (
        <>
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-0 h-0.5 bg-foreground/70"
          />
          <span
            {...pressable(() => ctx.activateChange(change))}
            tabIndex={-1}
            aria-label={`Label changed: ${changeWords(change)}. Open the cause.`}
            title={`${changeWords(change)}: ${change.cause.summary}`}
            className="absolute inset-0 flex cursor-pointer items-center justify-center transition-colors hover:bg-foreground/10"
          >
            <span className="flex size-4 items-center justify-center rounded-full bg-card shadow-sm">
              <span
                className={cn(
                  "flex size-4 items-center justify-center rounded-full ring-1 ring-inset",
                  change.tone,
                  ctx.isChangeActive(change) && "ring-2 ring-primary",
                )}
              >
                <Icon className="size-2.5" aria-hidden="true" />
              </span>
            </span>
          </span>
        </>
      ) : null}
    </span>
  );
}

/** "Trust → Suspicious" on the change row's detail line, beside the gutter. */
function ChangePill({
  change,
  ctx,
  tabbable,
}: {
  change: LabelChange;
  ctx: GuardCtx;
  tabbable: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          {...pressable(() => ctx.activateChange(change))}
          tabIndex={tabbable ? 0 : -1}
          aria-label={`Label changed: ${changeWords(change)}. ${change.cause.summary}. Open the cause.`}
          className={cn(
            PILL_BASE,
            "mr-1 after:absolute after:-inset-x-0.5 after:-inset-y-1 after:content-['']",
            change.tone,
            ctx.isChangeActive(change) && "ring-2 ring-primary",
          )}
        >
          <ChangeText change={change} />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p className="font-medium">{change.cause.summary}</p>
        <p className="opacity-80">{causeHint(change)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ChangeText({ change }: { change: LabelChange }) {
  const Icon = CHANGE_ICON[change.cause.kind];
  return (
    <>
      <Icon className="size-2.5 shrink-0" aria-hidden="true" />
      {change.parts.map((part, index) => (
        <span key={part.field} className="inline-flex items-center gap-0.5">
          {index > 0 ? <span className="opacity-50">·</span> : null}
          {/* Phones keep the new value; the gutter says which field. */}
          <span className="font-medium opacity-80 max-lg:hidden">
            {part.field}
          </span>
          <span aria-hidden="true">→</span>
          <span>{part.to}</span>
        </span>
      ))}
    </>
  );
}

/** One guardrail check: a shield in a 20px chip that opens it below. */
function ConsultShield({
  consult,
  selected,
  tabbable,
  onOpen,
}: {
  consult: MockConsult;
  selected: boolean;
  tabbable: boolean;
  onOpen: (key: string) => void;
}) {
  const decision = DECISION_TONE[consult.decision];
  const plain = consult.decision !== "blocked" && consult.outcome === "answered";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          {...pressable(() => onOpen(consult.key))}
          tabIndex={tabbable ? 0 : -1}
          aria-pressed={selected}
          aria-label={`${consult.externalName} check, ${decision.label}${consult.outcome !== "answered" ? `, ${consult.outcome.replace("_", " ")}` : ""}. Open its details`}
          className={cn(
            "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md bg-card shadow-xs ring-1 ring-border transition-colors hover:bg-muted hover:ring-foreground/40",
            "focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
            consult.decision === "blocked" && "ring-rose-500/60",
            selected &&
              "bg-primary/15 ring-2 ring-primary hover:bg-primary/20 hover:ring-primary",
          )}
        >
          <DecisionIcon
            consult={consult}
            className={cn("size-3.5", plain && SHIELD_TONE[consult.decision])}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <p>
          <span className="font-medium">{consult.externalName}</span> ·{" "}
          {ROLE_LABEL[consult.role]} ·{" "}
          {consult.beforeCall ? "before the call" : "on the result"}
        </p>
        <p>
          {decision.label}: {consult.answer} ·{" "}
          {formatLatency(consult.durationMs)}
        </p>
        <p className="opacity-70">Click to open this check below</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The gutter's key in plain words, and every label change as a jump link. */
function GutterLegend({ guards, ctx }: { guards: RowGuards; ctx: GuardCtx }) {
  return (
    <div className="flex flex-col gap-1.5 border-b bg-muted/30 px-4 py-2 text-[11px] text-muted-foreground lg:flex-row lg:items-center lg:gap-x-6">
      <ul
        aria-label="Label gutter key"
        className="flex flex-wrap items-center gap-x-3 gap-y-1"
      >
        <li className="font-medium text-foreground/80">
          Left gutter = session label
        </li>
        <li className="inline-flex items-center gap-1.5">
          <GutterSwatch className={GUTTER_FILL.trusted} />
          Trusted
        </li>
        <li className="inline-flex items-center gap-1.5">
          <GutterSwatch className={GUTTER_FILL.suspicious} />
          Suspicious
        </li>
        <li className="inline-flex items-center gap-1.5">
          <GutterSwatch className="bg-muted" striped />
          Striped = audience narrowed
          <span className="max-lg:hidden">(internal, a team, self)</span>
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-flex size-4 items-center justify-center rounded bg-card ring-1 ring-border">
            <ShieldCheck className="size-3" aria-hidden="true" />
          </span>
          Guardrail check, click for details
        </li>
      </ul>
      {guards.changes.length > 0 ? (
        <div className="flex min-w-0 items-center gap-2 lg:ml-auto">
          <span className="shrink-0">
            {guards.changes.length} label{" "}
            {guards.changes.length === 1 ? "change" : "changes"}
          </span>
          <div className="-my-1 flex min-w-0 items-center gap-1 overflow-x-auto py-1">
            {guards.changes.map((change) => (
              <UnstyledButton
                key={change.spanKey}
                onClick={() => ctx.activateChange(change)}
                title={`${change.cause.summary}. ${causeHint(change)}`}
                className={cn(
                  PILL_BASE,
                  "h-5",
                  change.tone,
                  ctx.isChangeActive(change) && "ring-2 ring-primary",
                )}
              >
                <ChangeText change={change} />
              </UnstyledButton>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function GutterSwatch({
  className,
  striped = false,
}: {
  className: string;
  striped?: boolean;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "relative h-3.5 w-3 shrink-0 overflow-hidden rounded-[2px] ring-1 ring-border/60 ring-inset",
        className,
      )}
    >
      {striped ? <span className={cn("absolute inset-0", STRIPES)} /> : null}
    </span>
  );
}

/** The page's check count, and a stepper through the blocked ones. */
function GuardStatus({ guards, ctx }: { guards: RowGuards; ctx: GuardCtx }) {
  if (guards.consults.length === 0) return null;
  const blocked = guards.consults.filter((c) => c.decision === "blocked");
  const showNextBlocked = () => {
    const index = blocked.findIndex((c) => c.key === ctx.selectedConsultKey);
    ctx.openConsult(blocked[(index + 1) % blocked.length].key);
  };
  return (
    <span className="ml-auto hidden items-center gap-2 lg:inline-flex">
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      <span>
        {guards.consults.length}{" "}
        {guards.consults.length === 1 ? "guardrail check" : "guardrail checks"}
      </span>
      {blocked.length > 0 ? (
        <UnstyledButton
          onClick={showNextBlocked}
          className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-medium text-rose-700 transition-colors hover:bg-rose-500/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none dark:text-rose-300"
        >
          <ShieldX className="size-3.5" aria-hidden="true" />
          {blocked.length} blocked · show
        </UnstyledButton>
      ) : null}
    </span>
  );
}

const GUTTER_FILL: Record<LabelSegment["trust"], string> = {
  trusted: "bg-emerald-500/25 dark:bg-emerald-400/20",
  suspicious: "bg-rose-500/50 dark:bg-rose-400/45",
};
const STRIPES =
  "bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgb(67_56_202/0.55)_3px_5px)] dark:bg-[repeating-linear-gradient(135deg,transparent_0_3px,rgb(199_210_254/0.5)_3px_5px)]";
const PILL_BASE =
  "relative inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ring-1 ring-inset transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";
const TRUST_PILL: Record<LabelSegment["trust"], string> = {
  suspicious:
    "bg-rose-500/15 text-rose-700 ring-rose-500/40 hover:bg-rose-500/25 dark:text-rose-300",
  trusted:
    "bg-emerald-500/15 text-emerald-700 ring-emerald-500/40 hover:bg-emerald-500/25 dark:text-emerald-300",
};
const AUDIENCE_PILL: Record<LabelSegment["audience"], string> = {
  public:
    "bg-sky-500/15 text-sky-700 ring-sky-500/40 hover:bg-sky-500/25 dark:text-sky-300",
  internal:
    "bg-indigo-500/15 text-indigo-700 ring-indigo-500/40 hover:bg-indigo-500/25 dark:text-indigo-300",
  "@payments":
    "bg-violet-500/15 text-violet-700 ring-violet-500/40 hover:bg-violet-500/25 dark:text-violet-300",
  self: "bg-fuchsia-500/15 text-fuchsia-700 ring-fuchsia-500/40 hover:bg-fuchsia-500/25 dark:text-fuchsia-300",
};
const RESET_PILL =
  "bg-muted text-foreground/80 ring-border hover:bg-muted/70";
const CHANGE_ICON: Record<
  NonNullable<LabelSegment["cause"]>["kind"],
  typeof ShieldAlert
> = {
  admitted: ShieldAlert,
  narrowed: Lock,
  released: Send,
  reset: RotateCcw,
};
const SHIELD_TONE: Record<MockConsult["decision"], string> = {
  allowed: "text-emerald-600 dark:text-emerald-400",
  approved: "text-emerald-600 dark:text-emerald-400",
  blocked: "",
  labeled: "text-indigo-600 dark:text-indigo-400",
  redacted: "text-amber-600 dark:text-amber-400",
};
