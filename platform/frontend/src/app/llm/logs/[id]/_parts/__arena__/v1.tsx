"use client";
// design-arena: do not commit
import {
  AUDIENCE_TONE,
  type GuardrailsData,
  type LabelSegment,
  type LabelState,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
} from "./guardrails-mock";
import { DecisionIcon } from "./guardrails-arena";

import {
  ArrowRight,
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import {
  Fragment,
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

  const guard = useMemo(
    () => (guardrails ? deriveGuardrails(guardrails, spans) : null),
    [guardrails, spans],
  );

  // Keep the selection in view inside the list when it changes from outside
  // it (the details pane's stepper, a page change landing on a new default,
  // a link to one tool call). Only the list scrolls: moving the page would
  // yank a reader who is looking at the details pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = selectedKey ? rowRefs.current.get(selectedKey) : undefined;
    if (scroller && row)
      scrollWithin(scroller, row, guard ? headerOffsetPx() : COLUMN_HEADER_PX);
  }, [selectedKey, guard]);

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

          {guard && guardrails && !loading && spans.length > 0 ? (
            <>
              <LabelLanes
                grid={grid}
                layout={layout}
                guard={guard}
                selectedKey={selectedKey}
                onSelect={onSelect}
              />
              <PhoneLabelLegend />
            </>
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
                  {guard?.changes.map((change) => (
                    <span
                      key={`label-change-${change.segment.start}`}
                      className="absolute inset-y-0 hidden w-px bg-foreground/20 lg:block"
                      style={{ left: `${change.segment.x * 100}%` }}
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
                  };
                  const guardProps = guard
                    ? {
                        gutter: guardrails?.labelAt(span.start) ?? null,
                        consults: guard.consultsByTool.get(span.key) ?? null,
                        selectedConsultKey,
                        onSelectConsult,
                      }
                    : {};
                  const changeRows = guard?.changesBefore.get(span.key) ?? [];
                  return (
                    <Fragment key={span.key}>
                      {changeRows.map((change) => (
                        <PhoneLabelChangeRow
                          key={`change-${change.segment.start}`}
                          change={change}
                          selected={change.jumpKey === selectedKey}
                          onSelect={onSelect}
                        />
                      ))}
                      {span.type === "request" ? (
                        <RequestRow
                          span={span}
                          profileName={profileName}
                          isConversation={span.row.id === conversationRowId}
                          {...rowProps}
                          {...guardProps}
                        />
                      ) : (
                        <ToolCallRow
                          span={span}
                          display={serverDisplayByName.get(
                            span.call.mcpServerName,
                          )}
                          {...rowProps}
                          {...guardProps}
                        />
                      )}
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
              extra={
                guard ? (
                  <GuardrailStatus
                    guard={guard}
                    selectedConsultKey={selectedConsultKey}
                    onSelectConsult={onSelectConsult}
                  />
                ) : null
              }
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
  extra = null,
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
  /** Arena: the guardrail checks summary, after the totals. */
  extra?: ReactNode;
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
  if (extra) parts.push({ key: "guardrails", text: extra, wideOnly: true });
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
  /** Arena: the label in force when the row started (phones' gutter). */
  gutter?: LabelState | null;
  /** Arena: this tool call's guardrail checks. */
  consults?: ToolConsults | null;
  selectedConsultKey?: string | null;
  onSelectConsult?: (key: string | null) => void;
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
  gutter = null,
  consults = null,
  selectedConsultKey = null,
  onSelectConsult,
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
  const marks = consults ? placeChecks(span, consults) : null;
  const latencyShift =
    marks && latencyPlacement === "after"
      ? marks.after.length * CHECK_STEP_PX
      : marks && latencyPlacement === "before"
        ? marks.before.length * CHECK_STEP_PX
        : 0;
  const phoneChecks =
    consults && onSelectConsult ? [...consults.before, ...consults.after] : [];
  return (
    <li className={gutter || marks ? "relative" : undefined}>
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
                  ? {
                      left: `calc(${(span.x + span.w) * 100}% + ${8 + latencyShift}px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + latencyShift}px)`,
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
        <span
          className={cn(
            "flex items-center justify-end gap-1.5 pr-4 tabular-nums",
            phoneChecks.length > 0 && !tools && "max-lg:invisible",
          )}
        >
          {tools ? (
            <span className={cn(!selected && "text-muted-foreground")}>
              {latency?.text ?? "—"}
            </span>
          ) : (
            cost
          )}
        </span>
      </UnstyledButton>

      {/* Arena: the checks sit over the row as siblings of its button, so
          each is its own button with its own focus and hit area. */}
      {marks && onSelectConsult ? (
        <div className={cn("pointer-events-none absolute inset-0 grid", grid)}>
          <span />
          <span className="relative mx-2 lg:mx-3">
            <span className="absolute inset-0 hidden lg:block">
              {marks.lines.map((consult) => (
                <span
                  key={`wait-${consult.key}`}
                  aria-hidden="true"
                  className={cn(
                    "absolute top-1/2 -translate-y-1/2 border-t border-dashed",
                    consult.decision === "blocked"
                      ? "border-rose-500/70"
                      : consult.outcome !== "answered"
                        ? "border-amber-500/70"
                        : "border-muted-foreground/50",
                  )}
                  style={{
                    left: `${consult.x * 100}%`,
                    width: `${consult.w * 100}%`,
                  }}
                />
              ))}
              {marks.before.map((consult, index) => (
                <CheckButton
                  key={consult.key}
                  consult={consult}
                  selected={consult.key === selectedConsultKey}
                  rowSelected={selected}
                  onSelectConsult={onSelectConsult}
                  className="top-1/2 -translate-y-1/2"
                  style={{
                    right: `calc(${(1 - span.x) * 100}% + ${index * CHECK_STEP_PX}px)`,
                  }}
                />
              ))}
              {marks.after.map((consult, index) => (
                <CheckButton
                  key={consult.key}
                  consult={consult}
                  selected={consult.key === selectedConsultKey}
                  rowSelected={selected}
                  onSelectConsult={onSelectConsult}
                  className="top-1/2 -translate-y-1/2"
                  style={{
                    left: `calc(${(span.x + span.w) * 100}% + ${2 + index * CHECK_STEP_PX}px)`,
                  }}
                />
              ))}
            </span>
            {tools ? (
              <PhoneChecks
                consults={phoneChecks}
                selectedConsultKey={selectedConsultKey}
                rowSelected={selected}
                onSelectConsult={onSelectConsult}
                className="absolute inset-y-0 right-0"
              />
            ) : null}
          </span>
          {tools ? null : (
            <>
              <span className="hidden lg:block" />
              <PhoneChecks
                consults={phoneChecks}
                selectedConsultKey={selectedConsultKey}
                rowSelected={selected}
                onSelectConsult={onSelectConsult}
                className="justify-end pr-2"
              />
            </>
          )}
        </div>
      ) : null}

      {gutter ? <Gutter state={gutter} /> : null}
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
// Arena: guardrail checks and the session label
// ============================================================================

type ToolConsults = { before: MockConsult[]; after: MockConsult[] };

/** A label move, and where the list jumps when it is clicked. */
type LabelChange = {
  segment: LabelSegment;
  /** Null on the session's opening label. */
  prev: LabelState | null;
  trustChanged: boolean;
  audienceChanged: boolean;
  /** The cause's tool call when it is on this page, else the next row. */
  jumpKey: string | null;
};

type LaneRun = {
  label: string;
  tone: { bar: string; text: string };
  x: number;
  w: number;
  change: LabelChange | null;
};

type DerivedGuardrails = {
  consultsByTool: Map<string, ToolConsults>;
  changes: LabelChange[];
  /** Phones: label rows to insert before a span, keyed by span. */
  changesBefore: Map<string, LabelChange[]>;
  trustRuns: LaneRun[];
  audienceRuns: LaneRun[];
  beforeCount: number;
  afterCount: number;
  blocked: MockConsult[];
};

/** Glyph-to-glyph spacing of the checks beside a bar (hit areas are 20px). */
const CHECK_STEP_PX = 20;
const LANES_PX = 52;
const PHONE_LEGEND_PX = 24;

function headerOffsetPx(): number {
  const wide =
    typeof window !== "undefined" &&
    window.matchMedia?.("(min-width: 64rem)").matches;
  return COLUMN_HEADER_PX + (wide ? LANES_PX : PHONE_LEGEND_PX);
}

function deriveGuardrails(
  data: GuardrailsData,
  spans: TimelineSpan[],
): DerivedGuardrails {
  const onPage = new Set(spans.map((span) => span.key));
  const consultsByTool = new Map<string, ToolConsults>();
  let beforeCount = 0;
  let afterCount = 0;
  const blocked: MockConsult[] = [];
  for (const consult of data.consults) {
    if (!consult.toolCallKey || !onPage.has(consult.toolCallKey)) continue;
    const entry = consultsByTool.get(consult.toolCallKey) ?? {
      before: [],
      after: [],
    };
    if (consult.beforeCall) {
      entry.before.push(consult);
      beforeCount++;
    } else {
      entry.after.push(consult);
      afterCount++;
    }
    if (consult.decision === "blocked") blocked.push(consult);
    consultsByTool.set(consult.toolCallKey, entry);
  }

  const firstAtOrAfter = (ms: number) =>
    spans.find((span) => span.start >= ms) ?? null;

  const all: LabelChange[] = data.labels.map((segment, index) => {
    const prev = index > 0 ? data.labels[index - 1] : null;
    const causeKey = segment.cause?.toolCallKey ?? null;
    return {
      segment,
      prev: prev ? { trust: prev.trust, audience: prev.audience } : null,
      trustChanged: !!prev && prev.trust !== segment.trust,
      audienceChanged: !!prev && prev.audience !== segment.audience,
      jumpKey:
        causeKey && onPage.has(causeKey)
          ? causeKey
          : (firstAtOrAfter(segment.start)?.key ?? null),
    };
  });
  const changes = all.filter((c) => c.prev && c.segment.cause);

  const changesBefore = new Map<string, LabelChange[]>();
  for (const change of all) {
    const anchor = change.prev
      ? firstAtOrAfter(change.segment.start)
      : (spans[0] ?? null);
    if (!anchor) continue;
    changesBefore.set(anchor.key, [
      ...(changesBefore.get(anchor.key) ?? []),
      change,
    ]);
  }

  const runs = (pick: "trust" | "audience"): LaneRun[] => {
    const out: LaneRun[] = [];
    for (const change of all) {
      const { segment } = change;
      const last = out[out.length - 1];
      const changed =
        pick === "trust" ? change.trustChanged : change.audienceChanged;
      if (last && !changed) {
        last.w = segment.x + segment.w - last.x;
        continue;
      }
      const tone =
        pick === "trust"
          ? TRUST_TONE[segment.trust]
          : AUDIENCE_TONE[segment.audience];
      out.push({
        label: tone.label,
        tone,
        x: segment.x,
        w: segment.w,
        change: change.prev ? change : null,
      });
    }
    return out;
  };

  return {
    consultsByTool,
    changes,
    changesBefore,
    trustRuns: runs("trust"),
    audienceRuns: runs("audience"),
    beforeCount,
    afterCount,
    blocked,
  };
}

/**
 * Authority checks go before the bar and result checks after it, unless the
 * bar hugs an edge of the track, where they move to the open side.
 */
function placeChecks(
  span: Pick<TimelineSpan, "x" | "w">,
  consults: ToolConsults,
) {
  let before = [...consults.before];
  let after = [...consults.after];
  if (span.x < 0.03) {
    after = [...before, ...after];
    before = [];
  } else if (span.x + span.w > 0.95) {
    before = [...after.reverse(), ...before];
    after = [];
  }
  return {
    before: before.reverse(),
    after,
    lines: consults.before.filter((c) => c.w > 0.002),
  };
}

function checkLabel(consult: MockConsult): string {
  return `${ROLE_LABEL[consult.role]} check ${consult.externalName} ${
    consult.beforeCall ? "before" : "on the result of"
  } ${consult.toolName ?? "the call"}: ${DECISION_LABEL[consult.decision]}${
    consult.outcome !== "answered"
      ? ` (${consult.outcome.replace("_", " ")})`
      : ""
  }. Open details.`;
}

const DECISION_LABEL: Record<MockConsult["decision"], string> = {
  allowed: "Allowed",
  approved: "Approved",
  blocked: "Blocked",
  labeled: "Labeled",
  redacted: "Redacted",
};

const SHIELD_TINT: Record<MockConsult["decision"], string> = {
  allowed: "text-emerald-600 dark:text-emerald-400",
  approved: "text-emerald-600 dark:text-emerald-400",
  blocked: "text-rose-600 dark:text-rose-400",
  labeled: "text-indigo-600 dark:text-indigo-400",
  redacted: "text-amber-600 dark:text-amber-400",
};

const TICK_TINT: Record<MockConsult["decision"], string> = {
  allowed: "bg-emerald-500 dark:bg-emerald-400",
  approved: "bg-emerald-500 dark:bg-emerald-400",
  blocked: "bg-rose-500 dark:bg-rose-400",
  labeled: "bg-indigo-500 dark:bg-indigo-400",
  redacted: "bg-amber-500 dark:bg-amber-400",
};

function CheckGlyph({ consult }: { consult: MockConsult }) {
  if (consult.beforeCall) {
    return (
      <DecisionIcon
        consult={consult}
        className={cn(
          "size-3.5",
          consult.outcome === "answered" && SHIELD_TINT[consult.decision],
        )}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-3 w-[5px] rounded-[2px]",
        consult.outcome === "answered"
          ? TICK_TINT[consult.decision]
          : "bg-transparent ring-[1.5px] ring-amber-500 ring-inset dark:ring-amber-400",
      )}
    />
  );
}

function CheckButton({
  consult,
  selected,
  rowSelected,
  onSelectConsult,
  className,
  style,
}: {
  consult: MockConsult;
  selected: boolean;
  rowSelected: boolean;
  onSelectConsult: (key: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          tabIndex={rowSelected || selected ? 0 : -1}
          aria-label={checkLabel(consult)}
          aria-pressed={selected}
          onClick={() => onSelectConsult(consult.key)}
          className={cn(
            "pointer-events-auto grid size-5 shrink-0 cursor-pointer place-items-center rounded-[5px] outline-none transition-[background-color,box-shadow,transform] duration-100",
            "hover:bg-foreground/10 hover:ring-1 hover:ring-foreground/20 active:scale-95",
            "focus-visible:ring-2 focus-visible:ring-ring/70",
            selected &&
              "bg-primary/15 ring-2 ring-primary hover:bg-primary/20 hover:ring-2 hover:ring-primary",
            className,
          )}
          style={style}
        >
          <CheckGlyph consult={consult} />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5 text-xs">
          <span className="font-medium">
            {ROLE_LABEL[consult.role]} · {consult.externalName}
          </span>
          <span>
            {DECISION_LABEL[consult.decision]}
            {consult.outcome !== "answered"
              ? ` (${consult.outcome.replace("_", " ")})`
              : ""}{" "}
            — {consult.answer}
          </span>
          <span className="opacity-70">
            {consult.beforeCall ? "Before the call" : "On the result"} ·{" "}
            {formatLatency(consult.durationMs)} · click for details
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/** Phones: a tool call's checks in a compact strip at the row's end. */
function PhoneChecks({
  consults,
  selectedConsultKey,
  rowSelected,
  onSelectConsult,
  className,
}: {
  consults: MockConsult[];
  selectedConsultKey: string | null;
  rowSelected: boolean;
  onSelectConsult: (key: string | null) => void;
  className?: string;
}) {
  if (consults.length === 0) return <span className="lg:hidden" />;
  const shown = consults.slice(0, 3);
  return (
    <span className={cn("flex items-center lg:hidden", className)}>
      {shown.map((consult) => (
        <CheckButton
          key={consult.key}
          consult={consult}
          selected={consult.key === selectedConsultKey}
          rowSelected={rowSelected}
          onSelectConsult={onSelectConsult}
          className="size-6"
        />
      ))}
      {consults.length > shown.length ? (
        <span className="text-[10px] text-muted-foreground">
          +{consults.length - shown.length}
        </span>
      ) : null}
    </span>
  );
}

/** Phones: two strips down the row's left edge, trust then audience. */
function Gutter({ state }: { state: LabelState }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-[3px] flex gap-px lg:hidden"
    >
      <span className={cn("w-[3px]", TRUST_TONE[state.trust].bar)} />
      <span className={cn("w-[3px]", AUDIENCE_TONE[state.audience].bar)} />
    </span>
  );
}

function PhoneLabelLegend() {
  return (
    <div className="sticky top-8 z-[14] flex h-6 items-center gap-1.5 border-b bg-card px-4 text-[10px] whitespace-nowrap text-muted-foreground lg:hidden">
      <span aria-hidden="true" className="flex h-3 gap-px">
        <span className="w-[3px] bg-emerald-500 dark:bg-emerald-400" />
        <span className="w-[3px] bg-sky-500/70 dark:bg-sky-400/70" />
      </span>
      <span className="truncate">
        Left edge: session label (trust, audience). Tap a change to jump.
      </span>
    </div>
  );
}

function LaneValue({
  lane,
  value,
  text,
}: {
  lane: string;
  value: string;
  text: string;
}) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-card px-1.5 leading-[18px] font-medium whitespace-nowrap">
      <span className="text-muted-foreground">{lane}</span>
      <ArrowRight className="size-2.5 text-muted-foreground" aria-hidden />
      <span className={text}>{value}</span>
    </span>
  );
}

/** Phones: a row between the list's rows where the label moved. */
function PhoneLabelChangeRow({
  change,
  selected,
  onSelect,
}: {
  change: LabelChange;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const { segment } = change;
  const trust = TRUST_TONE[segment.trust];
  const audience = AUDIENCE_TONE[segment.audience];
  return (
    <li className="relative lg:hidden">
      {change.prev ? (
        <UnstyledButton
          onClick={() => change.jumpKey && onSelect(change.jumpKey)}
          aria-label={`Label changed: ${[
            change.trustChanged ? `trust to ${trust.label}` : null,
            change.audienceChanged ? `audience to ${audience.label}` : null,
          ]
            .filter(Boolean)
            .join(", ")}. ${segment.cause?.summary ?? ""}. Select the cause.`}
          className={cn(
            "flex h-9 w-full cursor-pointer items-center gap-1.5 border-b border-border/40 bg-muted/50 pr-3 pl-4 text-left text-[11px] outline-none transition-colors hover:bg-muted active:bg-muted",
            "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
            selected && "bg-primary/[0.07]",
          )}
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            {change.trustChanged ? (
              <LaneValue lane="Trust" value={trust.label} text={trust.text} />
            ) : null}
            {change.audienceChanged ? (
              <LaneValue
                lane="Audience"
                value={audience.label}
                text={audience.text}
              />
            ) : null}
            <span className="min-w-0 truncate text-muted-foreground">
              {segment.cause?.toolName
                ? `after ${segment.cause.toolName}`
                : segment.cause?.summary}
            </span>
          </span>
          <span className="shrink-0 text-[10px] font-medium text-primary">
            Show
          </span>
        </UnstyledButton>
      ) : (
        <div className="flex h-7 items-center gap-1 border-b border-border/40 bg-muted/30 pr-3 pl-4 text-[11px] text-muted-foreground">
          <span>Session starts</span>
          <span className={cn("font-medium", trust.text)}>{trust.label}</span>
          <span aria-hidden="true">·</span>
          <span className={cn("font-medium", audience.text)}>
            {audience.label}
          </span>
        </div>
      )}
      <Gutter state={segment} />
      {change.prev ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 left-[1px] size-3 -translate-y-1/2 rounded-full border-2 border-card bg-foreground"
        />
      ) : null}
    </li>
  );
}

/**
 * Wide: two sticky lanes under the axis, named in words, each run tinted and
 * every change a clickable "→ Value" pill at the moment it happened.
 */
function LabelLanes({
  grid,
  layout,
  guard,
  selectedKey,
  onSelect,
}: {
  grid: string;
  layout: Layout;
  guard: DerivedGuardrails;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div
      className={cn(
        "sticky top-8 z-[14] hidden border-b bg-card lg:grid",
        grid,
      )}
      style={{ height: LANES_PX }}
    >
      <div className="flex flex-col justify-center gap-0.5 pr-3 pl-4 text-[11px] font-medium text-muted-foreground">
        <span className="flex h-5 items-center justify-between gap-2">
          <span>Trust</span>
          <span className="truncate text-[10px] font-normal text-muted-foreground/60">
            click a change to see its cause
          </span>
        </span>
        <span className="flex h-5 items-center">Audience</span>
      </div>
      <div className="relative mx-3 flex flex-col justify-center gap-0.5">
        <Lane
          name="Trust"
          runs={guard.trustRuns}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
        <Lane
          name="Audience"
          runs={guard.audienceRuns}
          selectedKey={selectedKey}
          onSelect={onSelect}
        />
      </div>
      {layout === "trace" ? <div /> : null}
      <div />
    </div>
  );
}

function Lane({
  name,
  runs,
  selectedKey,
  onSelect,
}: {
  name: string;
  runs: LaneRun[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  return (
    <div className="relative h-5">
      {runs.map((run) => (
        <span
          key={`run-${run.x}`}
          aria-hidden="true"
          className="absolute inset-y-[3px] overflow-hidden rounded-[3px]"
          style={{
            left: `${run.x * 100}%`,
            width: `max(2px, ${run.w * 100}%)`,
          }}
        >
          <span className={cn("absolute inset-0 opacity-15", run.tone.bar)} />
          <span
            className={cn("absolute inset-x-0 bottom-0 h-[2px]", run.tone.bar)}
          />
        </span>
      ))}
      {runs.map((run) =>
        !run.change && run.w > 0.05 ? (
          <span
            key={`text-${run.x}`}
            className={cn(
              "pointer-events-none absolute top-1/2 -translate-y-1/2 px-1.5 text-[10px] font-medium whitespace-nowrap",
              run.tone.text,
            )}
            style={{ left: `${run.x * 100}%` }}
          >
            {run.label}
          </span>
        ) : null,
      )}
      {runs.map((run) => {
        const change = run.change;
        if (!change) return null;
        const cause = change.segment.cause;
        const selected = !!change.jumpKey && change.jumpKey === selectedKey;
        return (
          <Tooltip key={`pill-${run.x}`}>
            <TooltipTrigger asChild>
              <UnstyledButton
                onClick={() => change.jumpKey && onSelect(change.jumpKey)}
                aria-label={`${name} changed to ${run.label}${
                  cause?.toolName ? ` after ${cause.toolName}` : ""
                }. Select the cause.`}
                aria-pressed={selected}
                className={cn(
                  "absolute top-1/2 z-[1] inline-flex h-5 -translate-y-1/2 cursor-pointer items-center gap-1 rounded-full border bg-card pr-2 pl-1.5 text-[10px] leading-none font-semibold whitespace-nowrap shadow-xs outline-none transition-colors",
                  "hover:border-foreground/40 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/70",
                  run.tone.text,
                  selected &&
                    "border-primary bg-primary/10 ring-1 ring-primary",
                )}
                style={
                  run.x > 0.86
                    ? { right: `calc(${(1 - run.x) * 100}% - 9px)` }
                    : { left: `calc(${run.x * 100}% - 9px)` }
                }
              >
                <span
                  aria-hidden="true"
                  className={cn("size-1.5 rounded-full", run.tone.bar)}
                />
                <ArrowRight className="size-2.5 opacity-70" aria-hidden />
                {run.label}
              </UnstyledButton>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-72">
              <div className="flex flex-col gap-0.5 text-xs">
                <span className="font-medium">
                  {name} → {run.label}
                </span>
                {cause ? <span>{cause.summary}</span> : null}
                <span className="opacity-70">
                  {cause?.toolName
                    ? `Click to select ${cause.toolName}`
                    : "Click to jump here"}
                </span>
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** Status bar: what the glyphs mean, as counts, and a jump to the blocks. */
function GuardrailStatus({
  guard,
  selectedConsultKey,
  onSelectConsult,
}: {
  guard: DerivedGuardrails;
  selectedConsultKey: string | null;
  onSelectConsult?: (key: string | null) => void;
}) {
  const { blocked } = guard;
  const current = blocked.findIndex((c) => c.key === selectedConsultKey);
  const next = blocked[(current + 1) % Math.max(1, blocked.length)];
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="inline-flex items-center gap-1">
        <ShieldCheck className="size-3.5" aria-hidden />
        {guard.beforeCount} checked before the call
      </span>
      <span className="inline-flex items-center gap-1">
        <span
          aria-hidden="true"
          className="h-3 w-[5px] rounded-[2px] bg-muted-foreground/70"
        />
        {guard.afterCount} on the result
      </span>
      {blocked.length > 0 && next && onSelectConsult ? (
        <UnstyledButton
          onClick={() => onSelectConsult(next.key)}
          className="-mx-1 inline-flex cursor-pointer items-center gap-1 rounded-sm px-1 font-medium text-rose-700 outline-none hover:bg-rose-500/10 focus-visible:ring-2 focus-visible:ring-ring/70 dark:text-rose-300"
          title="Open the next blocked check"
        >
          {blocked.length} blocked
          <ArrowRight className="size-3" aria-hidden />
        </UnstyledButton>
      ) : null}
    </span>
  );
}
