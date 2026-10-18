"use client";
// design-arena: do not commit

import {
  ChevronRight,
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import {
  type CSSProperties,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
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
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  const bandRef = useRef<HTMLDivElement>(null);
  const guard = useGuardrailIndex(guardrails, spans);

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
      scrollWithin(scroller, row, bandRef.current?.offsetHeight ?? 0);
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
      {guardrails && guard ? (
        <PhoneGuardrailsLegend guardrails={guardrails} guard={guard} />
      ) : null}

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

          {guardrails && guard && !loading && spans.length > 0 ? (
            <GuardrailsBand
              containerRef={bandRef}
              guardrails={guardrails}
              guard={guard}
              grid={grid}
              layout={layout}
              spans={spans}
              selectedKey={selectedKey}
              selectedConsultKey={selectedConsultKey}
              onSelect={onSelect}
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
                  {guardrails?.labels.slice(1).map((seg) => (
                    <span
                      key={`label-line-${seg.start}`}
                      className={cn(
                        "absolute inset-y-0 hidden w-px opacity-40 lg:block",
                        TRUST_TONE[seg.trust].bar,
                      )}
                      style={{ left: `${seg.x * 100}%` }}
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
                {guard?.pageStart ? (
                  <PhoneLabelDivider
                    segment={guard.pageStart}
                    previous={null}
                    target={null}
                    onSelect={onSelect}
                  />
                ) : null}
                {spans.map((span) => {
                  const dividers = guard?.dividersBefore.get(span.key) ?? [];
                  const trailing = guard?.dividersAfter.get(span.key) ?? [];
                  const rowGuard: RowGuard | null =
                    guardrails && guard
                      ? {
                          trust: guardrails.labelAt(span.start).trust,
                          consults: guard.consultsByCall.get(span.key) ?? [],
                          change: guard.changeByCall.get(span.key) ?? null,
                          selectedConsultKey,
                          onSelectConsult,
                        }
                      : null;
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
                  if (dividers.length === 0 && trailing.length === 0)
                    return row;
                  return (
                    <Fragment key={span.key}>
                      {dividers.map((d) => (
                        <PhoneLabelDivider
                          key={`divider-${d.segment.start}`}
                          segment={d.segment}
                          previous={d.previous}
                          target={span.key}
                          onSelect={onSelect}
                        />
                      ))}
                      {row}
                      {trailing.map((d) => (
                        <PhoneLabelDivider
                          key={`divider-${d.segment.start}`}
                          segment={d.segment}
                          previous={d.previous}
                          target={span.key}
                          onSelect={onSelect}
                        />
                      ))}
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
  pinnedPx: number,
) {
  const box = scroller.getBoundingClientRect();
  const rect = row.getBoundingClientRect();
  const top = rect.top - box.top + scroller.scrollTop;
  const bottom = top + rect.height;
  const clear = COLUMN_HEADER_PX + pinnedPx;
  if (top - clear < scroller.scrollTop) {
    scroller.scrollTop = top - clear;
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
  /** Guardrails for this row (arena); null renders the production row. */
  guard: RowGuard | null;
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
  guard,
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
  // Shields sit just before the bar (checks on the call) and just after it
  // (checks on the result); the duration label moves out past them.
  const before = guard?.consults.filter((c) => c.beforeCall) ?? [];
  const after = guard?.consults.filter((c) => !c.beforeCall) ?? [];
  const beforePx = markerGroupPx(before);
  const afterPx = markerGroupPx(after);
  return (
    <li className={guard ? "relative" : undefined}>
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
                      left: `calc(${(span.x + span.w) * 100}% + ${8 + afterPx}px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + beforePx}px)`,
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
      {guard ? (
        <RowGuardOverlay
          span={span}
          grid={grid}
          tools={tools}
          guard={guard}
          before={before}
          after={after}
        />
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
          {rowProps.guard?.change ? (
            <LabelChangeChip change={rowProps.guard.change} />
          ) : null}
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
// Guardrails (design arena): a pinned band at the top of the list with the
// label in words and every check as a shield; shields beside guarded bars;
// on phones a trust gutter down the rows with a divider row at each change.
// ============================================================================

type LabelChange = { segment: LabelSegment; previous: LabelSegment };

type RowGuard = {
  /** The trust label in force when the row started (the phone gutter). */
  trust: LabelSegment["trust"];
  consults: MockConsult[];
  /** The label change this row's tool call caused, if any. */
  change: LabelChange | null;
  selectedConsultKey: string | null;
  onSelectConsult: ((key: string | null) => void) | undefined;
};

type GuardrailIndex = {
  consultsByCall: Map<string, MockConsult[]>;
  changeByCall: Map<string, LabelChange>;
  /** Phone divider rows, keyed by the row they sit above / below. */
  dividersBefore: Map<string, LabelChange[]>;
  dividersAfter: Map<string, LabelChange[]>;
  /** The label in force at this page's first row. */
  pageStart: LabelSegment | null;
  blocked: number;
  changes: number;
};

const SEG_STYLE: Record<
  LabelSegment["trust"],
  { fill: string; border: string; edge: string }
> = {
  trusted: {
    fill: "bg-emerald-500/10 dark:bg-emerald-400/10",
    border: "border-emerald-500/30 dark:border-emerald-400/25",
    edge: "border-l-emerald-500 dark:border-l-emerald-400",
  },
  suspicious: {
    fill: "bg-rose-500/[0.13] dark:bg-rose-400/15",
    border: "border-rose-500/40 dark:border-rose-400/35",
    edge: "border-l-rose-500 dark:border-l-rose-400",
  },
};

/** Clicks and keys on a marker stay off the row underneath. */
const MARKER_BUTTON =
  "pointer-events-auto inline-flex h-5 min-w-5 cursor-pointer items-center justify-center gap-0.5 rounded-full bg-card px-[3px] shadow-xs ring-1 ring-border outline-none transition-[background-color,box-shadow] hover:bg-muted hover:ring-foreground/35 focus-visible:ring-2 focus-visible:ring-ring";
const MARKER_SELECTED = "bg-primary/15 ring-2 ring-primary hover:bg-primary/20";

function useGuardrailIndex(
  guardrails: GuardrailsData | null,
  spans: TimelineSpan[],
): GuardrailIndex | null {
  return useMemo(() => {
    if (!guardrails || spans.length === 0) return null;
    const consultsByCall = new Map<string, MockConsult[]>();
    for (const c of guardrails.consults) {
      if (!c.toolCallKey) continue;
      const list = consultsByCall.get(c.toolCallKey) ?? [];
      list.push(c);
      consultsByCall.set(c.toolCallKey, list);
    }
    const first = spans[0];
    const last = Math.max(...spans.map((s) => s.end));
    const changeByCall = new Map<string, LabelChange>();
    const dividersBefore = new Map<string, LabelChange[]>();
    const dividersAfter = new Map<string, LabelChange[]>();
    const add = (
      map: Map<string, LabelChange[]>,
      key: string,
      change: LabelChange,
    ) => map.set(key, [...(map.get(key) ?? []), change]);
    guardrails.labels.forEach((segment, i) => {
      if (i === 0 || segment.start < first.start || segment.start > last)
        return;
      const change = { segment, previous: guardrails.labels[i - 1] };
      const causeKey = segment.cause?.toolCallKey ?? null;
      const cause = causeKey
        ? spans.find((s) => s.key === causeKey)
        : undefined;
      if (cause) {
        changeByCall.set(cause.key, change);
        // A result that moved the label: the divider follows its row.
        add(
          segment.start >= cause.end - 1 ? dividersAfter : dividersBefore,
          cause.key,
          change,
        );
        return;
      }
      const at = spans.find((s) => s.start >= segment.start);
      if (at) add(dividersBefore, at.key, change);
    });
    const pageStart =
      guardrails.labels.find(
        (seg) => first.start >= seg.start && first.start < seg.end,
      ) ??
      guardrails.labels[0] ??
      null;
    return {
      consultsByCall,
      changeByCall,
      dividersBefore,
      dividersAfter,
      pageStart,
      blocked: guardrails.consults.filter((c) => c.decision === "blocked")
        .length,
      changes: Math.max(0, guardrails.labels.length - 1),
    };
  }, [guardrails, spans]);
}

/** The pinned "Guardrails" row: checks lane over label lane, desktop only. */
function GuardrailsBand({
  containerRef,
  guardrails,
  guard,
  grid,
  layout,
  spans,
  selectedKey,
  selectedConsultKey,
  onSelect,
  onSelectConsult,
}: {
  containerRef: RefObject<HTMLDivElement | null>;
  guardrails: GuardrailsData;
  guard: GuardrailIndex;
  grid: string;
  layout: Layout;
  spans: TimelineSpan[];
  selectedKey: string | null;
  selectedConsultKey: string | null;
  onSelect: (key: string) => void;
  onSelectConsult: ((key: string | null) => void) | undefined;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(trackRef);
  const clusters = useMemo(
    () => clusterByPx(guardrails.consults, width),
    [guardrails.consults, width],
  );
  const jumpTo = (segment: LabelSegment) => {
    const causeKey = segment.cause?.toolCallKey;
    const key =
      causeKey && spans.some((s) => s.key === causeKey)
        ? causeKey
        : (spans.find((s) => s.start >= segment.start) ?? spans.at(-1))?.key;
    if (key) onSelect(key);
  };
  const count = guardrails.consults.length;
  return (
    <div
      ref={containerRef}
      className={cn(
        "sticky top-8 z-[14] hidden h-[54px] border-b bg-card lg:grid",
        grid,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pr-3 pl-4">
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-md bg-muted">
          <ShieldCheck
            className="size-4 text-foreground/70"
            aria-hidden="true"
          />
        </span>
        <span className="flex min-w-0 flex-col gap-px">
          <span className="text-[13px] leading-[18px] font-medium">
            Guardrails
          </span>
          <span className="truncate text-[11px] leading-4 text-muted-foreground tabular-nums">
            {count} {count === 1 ? "check" : "checks"}
            {guard.blocked > 0 ? (
              <span className="text-rose-700 dark:text-rose-300">
                {" "}
                · {guard.blocked} blocked
              </span>
            ) : null}{" "}
            · {guard.changes} label {guard.changes === 1 ? "change" : "changes"}
          </span>
        </span>
      </div>

      <div ref={trackRef} className="relative mx-3">
        {/* Checks lane */}
        <div className="absolute inset-x-0 top-[5px] h-5">
          <span
            aria-hidden="true"
            className="absolute inset-x-0 top-1/2 h-px bg-border/70"
          />
          {clusters.map((cluster) => (
            <ConsultMarkers
              key={cluster.items[0].key}
              items={cluster.items}
              maxSingles={1}
              selectedConsultKey={selectedConsultKey}
              onSelectConsult={onSelectConsult}
              className="absolute top-0 -translate-x-1/2"
              style={{ left: `${cluster.x * 100}%` }}
            />
          ))}
        </div>
        {/* Label lane */}
        <div className="absolute inset-x-0 bottom-[5px] h-[22px]">
          {guardrails.labels.map((segment, i) => (
            <LabelSegmentButton
              key={segment.start}
              segment={segment}
              previous={i > 0 ? guardrails.labels[i - 1] : null}
              widthPx={segment.w * width}
              selected={
                !!segment.cause?.toolCallKey &&
                segment.cause.toolCallKey === selectedKey
              }
              onJump={() => jumpTo(segment)}
            />
          ))}
        </div>
      </div>

      {layout === "trace" ? <div className="hidden lg:block" /> : null}
      {/* Plain-word names for the two lanes. */}
      <div className="flex flex-col items-end justify-between py-[7px] pr-4 text-[10px] leading-4 font-medium text-muted-foreground uppercase tracking-wide">
        <span>Checks</span>
        <span>Label</span>
      </div>
    </div>
  );
}

function LabelSegmentButton({
  segment,
  previous,
  widthPx,
  selected,
  onJump,
}: {
  segment: LabelSegment;
  previous: LabelSegment | null;
  widthPx: number;
  selected: boolean;
  onJump: () => void;
}) {
  const parts = previous ? changeParts(previous, segment) : [];
  const trustChanged = parts.some((p) => p.dim === "Trust");
  const audienceChanged = parts.some((p) => p.dim === "Audience");
  const trust = TRUST_TONE[segment.trust];
  const audience = AUDIENCE_TONE[segment.audience];
  const style = SEG_STYLE[segment.trust];
  const state = `${trust.label} · ${audience.label}`;
  const target = segment.cause?.toolName;
  const dim = (
    name: string,
    changed: boolean,
    value: string,
    tone: string,
    named: boolean,
  ) => (
    <span className="inline-flex items-center gap-1">
      {changed && named ? (
        <span className="text-muted-foreground">{name} →</span>
      ) : null}
      <span className={cn(tone, changed && "font-semibold")}>{value}</span>
    </span>
  );
  const content =
    widthPx >= 92 ? (
      <>
        {dim("Trust", trustChanged, trust.label, trust.text, widthPx >= 210)}
        <span aria-hidden="true" className="text-muted-foreground/60">
          ·
        </span>
        {dim(
          "Audience",
          audienceChanged,
          audience.label,
          audience.text,
          widthPx >= 210,
        )}
      </>
    ) : widthPx >= 46 ? (
      <span className={cn("truncate font-medium", trust.text)}>
        {trust.label}
      </span>
    ) : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={onJump}
          aria-label={
            previous
              ? `${parts.map((p) => `${p.dim} changed to ${p.to}`).join(", ")}${target ? `, caused by ${target}` : ""}. Select it.`
              : `Session starts ${state}`
          }
          className={cn(
            "absolute inset-y-0 flex cursor-pointer items-center gap-1 overflow-hidden rounded-[4px] border px-1.5 text-[11px] leading-none whitespace-nowrap outline-none transition-[filter,box-shadow]",
            "hover:ring-1 hover:ring-foreground/30 hover:brightness-95 dark:hover:brightness-125",
            "focus-visible:ring-2 focus-visible:ring-ring",
            style.fill,
            style.border,
            previous && ["border-l-[3px]", style.edge],
            selected && "ring-2 ring-primary/70",
          )}
          style={{
            left: `calc(${segment.x * 100}% + 1px)`,
            width: `max(6px, calc(${segment.w * 100}% - 2px))`,
          }}
        >
          {content}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-72">
        <div className="space-y-1">
          <p className="font-medium">
            {previous
              ? parts.map((p) => `${p.dim}: ${p.from} → ${p.to}`).join(" · ")
              : `Session starts ${state}`}
          </p>
          {segment.cause ? (
            <p className="opacity-80">{segment.cause.summary}</p>
          ) : null}
          {previous ? (
            <p className="opacity-70">
              {segment.cause?.toolCallKey && target
                ? `Click to select ${target}`
                : "Click to jump to this point"}
            </p>
          ) : null}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * One check as a shield, or several as a "+N" bubble that opens a list.
 * `maxSingles` is how many shields show side by side before they bundle.
 */
function ConsultMarkers({
  items,
  maxSingles,
  selectedConsultKey,
  onSelectConsult,
  className,
  style,
}: {
  items: MockConsult[];
  maxSingles: number;
  selectedConsultKey: string | null;
  onSelectConsult: ((key: string | null) => void) | undefined;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps arrow keys and Enter from reaching the row list
    <span
      className={cn("flex items-center gap-0.5", className)}
      style={style}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {items.length <= maxSingles ? (
        items.map((consult) => (
          <ConsultShield
            key={consult.key}
            consult={consult}
            selected={consult.key === selectedConsultKey}
            onOpen={() => onSelectConsult?.(consult.key)}
          />
        ))
      ) : (
        <ConsultCluster
          items={items}
          selectedConsultKey={selectedConsultKey}
          onSelectConsult={onSelectConsult}
        />
      )}
    </span>
  );
}

function ConsultShield({
  consult,
  selected,
  onOpen,
}: {
  consult: MockConsult;
  selected: boolean;
  onOpen: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={onOpen}
          aria-label={`${ROLE_LABEL[consult.role]} ${consult.externalName}: ${DECISION_TONE[consult.decision].label}. Open check.`}
          aria-pressed={selected}
          className={cn(MARKER_BUTTON, selected && MARKER_SELECTED)}
        >
          <DecisionIcon consult={consult} className={consultTone(consult)} />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <ConsultSummary consult={consult} />
        <p className="mt-1 opacity-70">Click to open the check below</p>
      </TooltipContent>
    </Tooltip>
  );
}

function ConsultCluster({
  items,
  selectedConsultKey,
  onSelectConsult,
}: {
  items: MockConsult[];
  selectedConsultKey: string | null;
  onSelectConsult: ((key: string | null) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const lead = worstConsult(items);
  const selected = items.some((c) => c.key === selectedConsultKey);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <UnstyledButton
          aria-label={`${items.length} guardrail checks. Show list.`}
          title={`${items.length} guardrail checks`}
          className={cn(
            MARKER_BUTTON,
            "pr-1.5",
            selected && MARKER_SELECTED,
            open && "ring-2 ring-ring",
          )}
        >
          <DecisionIcon consult={lead} className={consultTone(lead)} />
          <span className="text-[10px] leading-none font-semibold tabular-nums text-foreground/80">
            +{items.length - 1}
          </span>
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="center"
        className="w-80 p-1"
        onKeyDown={(event) => event.stopPropagation()}
      >
        <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
          {items.length} guardrail checks
        </p>
        <ul className="max-h-64 overflow-auto">
          {items.map((consult) => (
            <li key={consult.key}>
              <UnstyledButton
                onClick={() => {
                  onSelectConsult?.(consult.key);
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted",
                  consult.key === selectedConsultKey && "bg-primary/10",
                )}
              >
                <DecisionIcon
                  consult={consult}
                  className={consultTone(consult)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono">
                    {consult.externalName}
                  </span>
                  <span className="block truncate text-[11px] text-muted-foreground">
                    {ROLE_LABEL[consult.role]}
                    {consult.toolName ? ` · ${consult.toolName}` : ""} ·{" "}
                    {consult.beforeCall ? "before the call" : "on the result"}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                    DECISION_TONE[consult.decision].chip,
                  )}
                >
                  {DECISION_TONE[consult.decision].label}
                </span>
                <ChevronRight
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                  aria-hidden="true"
                />
              </UnstyledButton>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ConsultSummary({ consult }: { consult: MockConsult }) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium">
        {DECISION_TONE[consult.decision].label} · {ROLE_LABEL[consult.role]}{" "}
        <span className="font-mono">{consult.externalName}</span>
      </p>
      <p className="opacity-80">
        {consult.toolName ? `${consult.toolName} · ` : ""}
        {consult.beforeCall ? "before the call" : "on the result"} ·{" "}
        {formatLatency(consult.durationMs)}
        {consult.outcome !== "answered"
          ? ` · ${consult.outcome === "timeout" ? "timed out" : "failed"}`
          : ""}
      </p>
      <p className="opacity-80">{consult.answer}</p>
    </div>
  );
}

/**
 * A row's guardrails: the phone trust gutter, and its checks as shields
 * (beside the bar on desktop, bundled at the track's end on phones).
 */
function RowGuardOverlay({
  span,
  grid,
  tools,
  guard,
  before,
  after,
}: {
  span: TimelineSpan;
  grid: string;
  tools: boolean;
  guard: RowGuard;
  before: MockConsult[];
  after: MockConsult[];
}) {
  const shared = {
    selectedConsultKey: guard.selectedConsultKey,
    onSelectConsult: guard.onSelectConsult,
  };
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1 w-[5px] lg:hidden",
          TRUST_TONE[guard.trust].bar,
        )}
      />
      {guard.consults.length > 0 ? (
        <div className={cn("pointer-events-none absolute inset-0 grid", grid)}>
          <span />
          <span className="relative mx-2 lg:mx-3">
            {before.length > 0 ? (
              <ConsultMarkers
                items={before}
                maxSingles={2}
                {...shared}
                className="absolute top-1/2 hidden -translate-y-1/2 lg:flex"
                style={{ right: `calc(${(1 - span.x) * 100}% + 3px)` }}
              />
            ) : null}
            {after.length > 0 ? (
              <ConsultMarkers
                items={after}
                maxSingles={2}
                {...shared}
                className="absolute top-1/2 hidden -translate-y-1/2 lg:flex"
                style={{
                  left: `calc(${span.x * 100}% + max(5px, ${span.w * 100}%) + 3px)`,
                }}
              />
            ) : null}
            <ConsultMarkers
              items={guard.consults}
              maxSingles={1}
              {...shared}
              className="absolute top-1/2 right-0 -translate-y-1/2 lg:hidden"
            />
          </span>
          {tools ? null : <span className="hidden lg:block" />}
          <span />
        </div>
      ) : null}
    </>
  );
}

/** On the row whose call moved the label: what changed, in words. */
function LabelChangeChip({ change }: { change: LabelChange }) {
  const parts = changeParts(change.previous, change.segment);
  const lead = parts[0];
  if (!lead) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            "hidden shrink-0 items-center gap-0.5 rounded-sm border px-1 text-[10px] leading-[14px] font-medium lg:inline-flex",
            SEG_STYLE[change.segment.trust].fill,
            SEG_STYLE[change.segment.trust].border,
            lead.tone,
          )}
        >
          {lead.dim} → {lead.to}
          {parts.length > 1 ? (
            <span className="text-muted-foreground">+1</span>
          ) : null}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <p className="font-medium">
          {parts.map((p) => `${p.dim}: ${p.from} → ${p.to}`).join(" · ")}
        </p>
        {change.segment.cause ? (
          <p className="opacity-80">{change.segment.cause.summary}</p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Phones: a row between rows where the label changes, in words. */
function PhoneLabelDivider({
  segment,
  previous,
  target,
  onSelect,
}: {
  segment: LabelSegment | null;
  previous: LabelSegment | null;
  target: string | null;
  onSelect: (key: string) => void;
}) {
  if (!segment) return null;
  const trust = TRUST_TONE[segment.trust];
  const audience = AUDIENCE_TONE[segment.audience];
  const gutter = (
    <span
      aria-hidden="true"
      className={cn("absolute inset-y-0 left-1 w-[5px]", trust.bar)}
    />
  );
  if (!previous) {
    return (
      <li className="relative lg:hidden">
        {gutter}
        <div className="flex h-8 items-center gap-1.5 border-b border-border/40 pr-4 pl-4 text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">
            Label{" "}
            <span className={cn("font-medium", trust.text)}>{trust.label}</span>{" "}
            ·{" "}
            <span className={cn("font-medium", audience.text)}>
              {audience.label}
            </span>
          </span>
        </div>
      </li>
    );
  }
  const parts = changeParts(previous, segment);
  return (
    <li className="relative lg:hidden">
      {gutter}
      <UnstyledButton
        disabled={!target}
        onClick={() => target && onSelect(target)}
        className={cn(
          "flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border/40 pr-4 pl-4 text-left text-[11px] outline-none active:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          SEG_STYLE[segment.trust].fill,
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col leading-4">
          <span className="truncate">
            {parts.map((p, i) => (
              <span key={p.dim}>
                {i > 0 ? (
                  <span className="text-muted-foreground/60"> · </span>
                ) : null}
                <span className="text-muted-foreground">{p.dim} → </span>
                <span className={cn("font-semibold", p.tone)}>{p.to}</span>
              </span>
            ))}
          </span>
          <span className="truncate text-[10px] text-muted-foreground">
            {segment.cause?.toolName
              ? `after ${segment.cause.toolName}`
              : (segment.cause?.summary ?? "")}
          </span>
        </span>
        <ChevronRight
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </UnstyledButton>
    </li>
  );
}

function PhoneGuardrailsLegend({
  guardrails,
  guard,
}: {
  guardrails: GuardrailsData;
  guard: GuardrailIndex;
}) {
  return (
    <div className="flex items-center gap-x-3 overflow-hidden border-b px-4 py-1.5 text-[11px] whitespace-nowrap text-muted-foreground lg:hidden">
      <span className="inline-flex items-center gap-1">
        <ShieldCheck className="size-3.5" aria-hidden="true" />
        {guardrails.consults.length} checks
        {guard.blocked > 0 ? (
          <span className="text-rose-700 dark:text-rose-300">
            · {guard.blocked} blocked
          </span>
        ) : null}
      </span>
      <span className="inline-flex items-center gap-1.5">
        Left edge:
        <span
          aria-hidden="true"
          className={cn("h-3 w-1 rounded-full", TRUST_TONE.trusted.bar)}
        />
        Trusted
        <span
          aria-hidden="true"
          className={cn("h-3 w-1 rounded-full", TRUST_TONE.suspicious.bar)}
        />
        Suspicious
      </span>
    </div>
  );
}

function changeParts(previous: LabelSegment, next: LabelSegment) {
  const parts: { dim: string; from: string; to: string; tone: string }[] = [];
  if (previous.trust !== next.trust)
    parts.push({
      dim: "Trust",
      from: TRUST_TONE[previous.trust].label,
      to: TRUST_TONE[next.trust].label,
      tone: TRUST_TONE[next.trust].text,
    });
  if (previous.audience !== next.audience)
    parts.push({
      dim: "Audience",
      from: AUDIENCE_TONE[previous.audience].label,
      to: AUDIENCE_TONE[next.audience].label,
      tone: AUDIENCE_TONE[next.audience].text,
    });
  return parts;
}

/** Width a row's marker group takes beside its bar, to move labels past it. */
function markerGroupPx(items: MockConsult[]) {
  if (items.length === 0) return 0;
  return items.length <= 2 ? items.length * 22 + 3 : 38;
}

/** Shields that would overlap at this width bundle into one bubble. */
function clusterByPx(consults: MockConsult[], widthPx: number) {
  const gap = widthPx > 0 ? 30 / widthPx : 0.03;
  const sorted = [...consults].sort((a, b) => a.x - b.x);
  const clusters: { items: MockConsult[]; x: number }[] = [];
  for (const consult of sorted) {
    const current = clusters.at(-1);
    const lastX = current?.items.at(-1)?.x ?? Number.NEGATIVE_INFINITY;
    const firstX = current?.items[0].x ?? Number.NEGATIVE_INFINITY;
    if (current && consult.x - lastX < gap && consult.x - firstX < gap * 2) {
      current.items.push(consult);
    } else {
      clusters.push({ items: [consult], x: consult.x });
    }
  }
  for (const cluster of clusters) {
    const first = cluster.items[0].x;
    const last = cluster.items[cluster.items.length - 1].x;
    cluster.x = (first + last) / 2;
  }
  return clusters;
}

const SEVERITY: Record<MockConsult["decision"], number> = {
  blocked: 5,
  redacted: 3,
  labeled: 2,
  approved: 1,
  allowed: 0,
};

function worstConsult(items: MockConsult[]) {
  const score = (c: MockConsult) =>
    SEVERITY[c.decision] + (c.outcome !== "answered" ? 4 : 0);
  return items.reduce((a, b) => (score(b) > score(a) ? b : a));
}

function consultTone(consult: MockConsult) {
  if (consult.decision === "blocked") return "text-rose-600 dark:text-rose-400";
  if (consult.outcome !== "answered")
    return "text-amber-600 dark:text-amber-400";
  return DECISION_TONE[consult.decision].text;
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
