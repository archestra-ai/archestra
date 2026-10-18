"use client";
// design-arena: do not commit
import {
  AUDIENCE_TONE,
  type Audience,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type LabelState,
  type MockConsult,
  ROLE_LABEL,
  TRUST_TONE,
  type Trust,
} from "./guardrails-mock";
import { DecisionIcon } from "./guardrails-arena";

import {
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import {
  type KeyboardEvent,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
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

  // Guardrails: each tool call's checks, the label's changes, and where each
  // change lands between rows (phones show it there as a divider).
  const pinnedRef = useRef<HTMLDivElement>(null);
  const guard = useMemo(
    () => buildGuardView(guardrails, spans),
    [guardrails, spans],
  );
  const pickConsult = (key: string) => onSelectConsult?.(key);
  const pickChange = (change: LabelChange) => {
    const key =
      change.segment.cause?.toolCallKey ??
      spans.find((span) => span.start >= change.segment.start)?.key ??
      spans[spans.length - 1]?.key;
    if (key) onSelect(key);
  };

  // Keep the selection in view inside the list when it changes from outside
  // it (the details pane's stepper, a page change landing on a new default,
  // a link to one tool call). Only the list scrolls: moving the page would
  // yank a reader who is looking at the details pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = selectedKey ? rowRefs.current.get(selectedKey) : undefined;
    if (scroller && row) {
      scrollWithin(
        scroller,
        row,
        COLUMN_HEADER_PX + (pinnedRef.current?.offsetHeight ?? 0),
      );
    }
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
      {guard && timeline ? (
        <PhoneLabelSummary
          guard={guard}
          origin={timeline.origin}
          selectedKey={selectedKey}
          selectedConsultKey={selectedConsultKey}
          onPickChange={pickChange}
          onPickConsult={pickConsult}
        />
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

          {guard && !loading && timeline && spans.length > 0 ? (
            <GuardrailLanes
              laneRef={pinnedRef}
              guard={guard}
              grid={grid}
              layout={layout}
              selected={selected}
              selectedKey={selectedKey}
              selectedConsultKey={selectedConsultKey}
              onPickChange={pickChange}
              onPickConsult={pickConsult}
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
                  const banners = guard?.bannersAt.get(index) ?? [];
                  const rowProps = {
                    layout,
                    gutter: guard?.data.labelAt(span.start) ?? null,
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
                        checks={guard?.checksByTool.get(span.key) ?? null}
                        selectedConsultKey={selectedConsultKey}
                        onPickConsult={pickConsult}
                        {...rowProps}
                      />
                    );
                  if (banners.length === 0) return row;
                  return [
                    ...banners.map((change) => (
                      <ChangeBanner
                        key={`change-${change.segment.start}`}
                        change={change}
                        selected={
                          !!change.segment.cause?.toolCallKey &&
                          change.segment.cause.toolCallKey === selectedKey
                        }
                        onPick={() => pickChange(change)}
                      />
                    )),
                    row,
                  ];
                })}
                {(guard?.bannersAt.get(spans.length) ?? []).map((change) => (
                  <ChangeBanner
                    key={`change-${change.segment.start}`}
                    change={change}
                    selected={false}
                    onPick={() => pickChange(change)}
                  />
                ))}
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
  /** The guardrails label in force when the row started (phones' gutter). */
  gutter: LabelState | null;
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
  gutter,
  overlay,
  latencyShift,
}: RowProps & {
  /** Clickable guardrail marks laid over the row, outside its button. */
  overlay?: ReactNode;
  /** Room the duration label leaves for a guardrail mark beside the bar. */
  latencyShift?: { after: number; before: number };
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
  const shiftAfter = latencyShift?.after ?? 0;
  const shiftBefore = latencyShift?.before ?? 0;
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
                      left: `calc(${(span.x + span.w) * 100}% + ${8 + shiftAfter}px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + shiftBefore}px)`,
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
      {gutter ? <LabelGutter label={gutter} /> : null}
      {overlay}
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
  checks,
  selectedConsultKey,
  onPickConsult,
  ...rowProps
}: RowProps & {
  span: ToolCallSpan;
  display: McpServerDisplay | undefined;
  checks: MockConsult[] | null;
  selectedConsultKey: string | null;
  onPickConsult: (key: string) => void;
}) {
  const before = checks?.filter((c) => c.beforeCall) ?? [];
  const after = checks?.filter((c) => !c.beforeCall) ?? [];
  const placement = placeLatency(span);
  const showAfter = after.length > 0 && span.x + span.w <= 0.95;
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
      cost={
        checks && rowProps.layout === "trace" ? null : (
          <span className="text-muted-foreground/50">—</span>
        )
      }
      latencyShift={{
        after: showAfter && placement === "after" ? 18 : 0,
        before: before.length > 0 && placement === "before" ? 18 : 0,
      }}
      overlay={
        checks ? (
          <RowGuardOverlay
            span={span}
            layout={rowProps.layout}
            checks={checks}
            before={before}
            after={showAfter ? after : []}
            selectedConsultKey={selectedConsultKey}
            onPick={onPickConsult}
          />
        ) : null
      }
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
// Guardrails (arena): pinned Trust / Audience / Checks lanes, row shields,
// and the phones' summary line, change dividers and label gutter.
// ============================================================================

type Lane = "trust" | "audience";

type LabelDiff = { lane: Lane; to: string };

type LabelChange = {
  segment: LabelSegment;
  previous: LabelState;
  diffs: LabelDiff[];
};

type LaneRun = {
  value: string;
  start: number;
  x: number;
  w: number;
  /** The change that started this run; null for the session's first value. */
  change: LabelChange | null;
};

type GuardView = {
  data: GuardrailsData;
  checksByTool: Map<string, MockConsult[]>;
  changes: LabelChange[];
  /** Row index → the changes that land just before that row. */
  bannersAt: Map<number, LabelChange[]>;
  trustRuns: LaneRun[];
  audienceRuns: LaneRun[];
  blocked: MockConsult[];
  /** Timed out or failed: the policy decided without an answer. */
  issues: MockConsult[];
  first: LabelState;
  current: LabelState;
};

const LANE_NAME: Record<Lane, string> = { trust: "Trust", audience: "Audience" };

function buildGuardView(
  data: GuardrailsData | null,
  spans: TimelineSpan[],
): GuardView | null {
  if (!data || data.labels.length === 0) return null;
  const checksByTool = new Map<string, MockConsult[]>();
  for (const consult of data.consults) {
    if (!consult.toolCallKey) continue;
    const list = checksByTool.get(consult.toolCallKey) ?? [];
    list.push(consult);
    checksByTool.set(consult.toolCallKey, list);
  }
  const changes: LabelChange[] = data.labels.slice(1).map((segment, i) => {
    const previous = data.labels[i];
    const diffs: LabelDiff[] = [];
    if (segment.trust !== previous.trust) {
      diffs.push({ lane: "trust", to: segment.trust });
    }
    if (segment.audience !== previous.audience) {
      diffs.push({ lane: "audience", to: segment.audience });
    }
    return { segment, previous, diffs };
  });
  const bannersAt = new Map<number, LabelChange[]>();
  for (const change of changes) {
    let index = spans.findIndex((span) => span.start >= change.segment.start);
    if (index === -1) index = spans.length;
    bannersAt.set(index, [...(bannersAt.get(index) ?? []), change]);
  }
  const runsFor = (lane: Lane): LaneRun[] => {
    const runs: LaneRun[] = [];
    data.labels.forEach((segment, i) => {
      const value = segment[lane];
      const last = runs[runs.length - 1];
      if (last && last.value === value) {
        last.w = segment.x + segment.w - last.x;
        return;
      }
      runs.push({
        value,
        start: segment.start,
        x: segment.x,
        w: segment.w,
        change: i === 0 ? null : (changes[i - 1] ?? null),
      });
    });
    return runs;
  };
  const last = data.labels[data.labels.length - 1];
  return {
    data,
    checksByTool,
    changes,
    bannersAt,
    trustRuns: runsFor("trust"),
    audienceRuns: runsFor("audience"),
    blocked: data.consults.filter((c) => c.decision === "blocked"),
    issues: data.consults.filter(
      (c) => c.decision !== "blocked" && c.outcome !== "answered",
    ),
    first: { trust: data.labels[0].trust, audience: data.labels[0].audience },
    current: { trust: last.trust, audience: last.audience },
  };
}

function laneTone(lane: Lane, value: string) {
  return lane === "trust"
    ? TRUST_TONE[value as Trust]
    : AUDIENCE_TONE[value as Audience];
}

/** The resting values, drawn quieter so a raised label stands out. */
function isQuiet(lane: Lane, value: string) {
  return lane === "trust" ? value === "trusted" : value === "public";
}

function severity(consult: MockConsult) {
  if (consult.decision === "blocked") return 3;
  if (consult.outcome !== "answered") return 2;
  if (consult.decision === "approved") return 1;
  return 0;
}

function worstOf(consults: MockConsult[]): MockConsult {
  return consults.reduce((a, b) => (severity(b) > severity(a) ? b : a));
}

/** Keeps the list's arrow and Enter keys from hijacking a nested control. */
function stopKeys(event: SyntheticEvent) {
  event.stopPropagation();
}

function useElementWidth(ref: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0]?.contentRect.width ?? 0),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** Wide screens: one pinned row under the axis with three labelled lanes. */
function GuardrailLanes({
  laneRef,
  guard,
  grid,
  layout,
  selected,
  selectedKey,
  selectedConsultKey,
  onPickChange,
  onPickConsult,
}: {
  laneRef: RefObject<HTMLDivElement | null>;
  guard: GuardView;
  grid: string;
  layout: Layout;
  selected: TimelineSpan | null;
  selectedKey: string | null;
  selectedConsultKey: string | null;
  onPickChange: (change: LabelChange) => void;
  onPickConsult: (key: string) => void;
}) {
  const consults = guard.data.consults;
  return (
    <div
      ref={laneRef}
      role="group"
      aria-label="Guardrails"
      className={cn(
        "sticky top-8 z-[14] hidden border-b bg-card shadow-[0_2px_6px_-4px_rgb(0_0_0/0.25)] lg:grid",
        grid,
      )}
    >
      <div className="flex flex-col gap-1 py-1.5 pr-3 pl-4 text-[11px] font-medium text-muted-foreground">
        <span className="flex h-4 items-center">Trust</span>
        <span className="flex h-4 items-center">Audience</span>
        <span className="flex h-5 items-center gap-1.5">
          Guardrail checks
          <span className="font-normal text-muted-foreground/70 tabular-nums">
            {consults.length}
          </span>
        </span>
      </div>
      <div className="relative mx-3 flex flex-col gap-1 py-1.5">
        <LabelLane
          lane="trust"
          runs={guard.trustRuns}
          selectedKey={selectedKey}
          onPick={onPickChange}
        />
        <LabelLane
          lane="audience"
          runs={guard.audienceRuns}
          selectedKey={selectedKey}
          onPick={onPickChange}
        />
        <ConsultLane
          consults={consults}
          selectedConsultKey={selectedConsultKey}
          onPick={onPickConsult}
        />
        {selected ? (
          <>
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-primary/60"
              style={{ left: `${selected.x * 100}%` }}
            />
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-y-0 border-l border-dashed border-primary/60"
              style={{ left: `${(selected.x + selected.w) * 100}%` }}
            />
          </>
        ) : null}
      </div>
      <div
        className={cn(
          "flex flex-col items-end justify-center gap-1 pr-4 text-[11px]",
          layout === "trace" && "col-span-2",
        )}
      >
        {guard.blocked.length === 0 && guard.issues.length === 0 ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <ShieldCheck className="size-3.5" aria-hidden="true" />
            All checks passed
          </span>
        ) : null}
        {guard.blocked.length > 0 ? (
          <NextConsultButton
            consults={guard.blocked}
            selectedConsultKey={selectedConsultKey}
            onPick={onPickConsult}
            text={`${guard.blocked.length} blocked`}
            className="bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
          />
        ) : null}
        {guard.issues.length > 0 ? (
          <NextConsultButton
            consults={guard.issues}
            selectedConsultKey={selectedConsultKey}
            onPick={onPickConsult}
            text={`${guard.issues.length} no answer`}
            className="bg-amber-500/10 text-amber-700 hover:bg-amber-500/20 dark:text-amber-300"
          />
        ) : null}
      </div>
    </div>
  );
}

/** Steps to the next consult in a list, from the one open now. */
function NextConsultButton({
  consults,
  selectedConsultKey,
  onPick,
  text,
  className,
}: {
  consults: MockConsult[];
  selectedConsultKey: string | null;
  onPick: (key: string) => void;
  text: string;
  className: string;
}) {
  const at = consults.findIndex((c) => c.key === selectedConsultKey);
  const next = consults[(at + 1) % consults.length];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => onPick(next.key)}
          className={cn(
            "inline-flex h-5 cursor-pointer items-center gap-0.5 rounded-sm pr-0.5 pl-1.5 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
            className,
          )}
        >
          {text}
          <ChevronRight className="size-3" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="left">
        Open {at === -1 ? "the first" : "the next"}: {next.externalName} on{" "}
        {next.toolName ?? "the session"}
      </TooltipContent>
    </Tooltip>
  );
}

function LabelLane({
  lane,
  runs,
  selectedKey,
  onPick,
}: {
  lane: Lane;
  runs: LaneRun[];
  selectedKey: string | null;
  onPick: (change: LabelChange) => void;
}) {
  return (
    <div className="relative h-4 rounded-[3px] bg-muted/50">
      {runs.map((run) => {
        const tone = laneTone(lane, run.value);
        return (
          <span
            key={`seg-${run.start}`}
            className="absolute inset-y-0 overflow-hidden rounded-[3px]"
            style={{ left: `${run.x * 100}%`, width: `${run.w * 100}%` }}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-0",
                tone.bar,
                isQuiet(lane, run.value) ? "opacity-[0.14]" : "opacity-30",
              )}
            />
            {run.change ? null : (
              <span
                className={cn(
                  "relative flex h-full items-center truncate px-1.5 text-[10px] font-medium",
                  tone.text,
                )}
              >
                {tone.label}
              </span>
            )}
          </span>
        );
      })}
      {runs.map((run) => {
        const change = run.change;
        if (!change) return null;
        const tone = laneTone(lane, run.value);
        const flip = run.x > 0.78;
        const cause = change.segment.cause;
        const isSelected =
          !!cause?.toolCallKey && cause.toolCallKey === selectedKey;
        return (
          <span key={`change-${run.start}`}>
            <span
              aria-hidden="true"
              className={cn(
                "pointer-events-none absolute -inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full",
                tone.bar,
              )}
              style={{ left: `${run.x * 100}%` }}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onPick(change)}
                  aria-label={`${LANE_NAME[lane]} changed to ${tone.label}${cause?.toolName ? ` by ${cause.toolName}` : ""}. Select the call.`}
                  className={cn(
                    "absolute top-0 z-[1] inline-flex h-4 cursor-pointer items-center gap-1 rounded-full border bg-card px-1.5 text-[10px] leading-none font-medium whitespace-nowrap shadow-xs outline-none transition-colors",
                    // A 20px hit area around the 16px pill.
                    "before:absolute before:-inset-0.5 before:content-['']",
                    "hover:bg-muted hover:ring-1 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring/60",
                    isSelected && "ring-2 ring-primary/70",
                  )}
                  style={
                    flip
                      ? { right: `calc(${(1 - run.x) * 100}% + 4px)` }
                      : { left: `calc(${run.x * 100}% + 4px)` }
                  }
                >
                  <span className="text-muted-foreground">
                    {cause?.kind === "reset"
                      ? `${LANE_NAME[lane]} reset`
                      : LANE_NAME[lane]}
                  </span>
                  <span aria-hidden="true" className="text-muted-foreground/60">
                    →
                  </span>
                  <span className={tone.text}>{tone.label}</span>
                </button>
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                <span className="block font-medium">
                  {cause?.summary ?? "Label changed"}
                </span>
                <span className="block opacity-80">
                  {cause?.toolName
                    ? `Caused by ${cause.toolName} · click to select it`
                    : "Click to jump to this point"}
                </span>
              </TooltipContent>
            </Tooltip>
          </span>
        );
      })}
    </div>
  );
}

function ConsultLane({
  consults,
  selectedConsultKey,
  onPick,
}: {
  consults: MockConsult[];
  selectedConsultKey: string | null;
  onPick: (key: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const clusters = useMemo(() => {
    const px = width > 0 ? width : 900;
    const out: { first: number; last: number; items: MockConsult[] }[] = [];
    for (const consult of [...consults].sort((a, b) => a.x - b.x)) {
      const current = out[out.length - 1];
      // Marks narrower than a finger apart share one button.
      if (current && (consult.x - current.first) * px < 26) {
        current.items.push(consult);
        current.last = consult.x;
      } else {
        out.push({ first: consult.x, last: consult.x, items: [consult] });
      }
    }
    return out;
  }, [consults, width]);
  return (
    <div ref={ref} className="relative h-5">
      <span
        aria-hidden="true"
        className="absolute inset-x-0 top-1/2 h-px bg-border"
      />
      {clusters.map((cluster) => (
        <ConsultMark
          key={cluster.items[0].key}
          variant="lane"
          consults={cluster.items}
          selectedConsultKey={selectedConsultKey}
          onPick={onPick}
          className="absolute top-0 -translate-x-1/2"
          style={{ left: `${((cluster.first + cluster.last) / 2) * 100}%` }}
        />
      ))}
    </div>
  );
}

/**
 * One or more consults behind one button: a single one opens straight into
 * the details pane, several open a short list to pick from.
 */
function ConsultMark({
  consults,
  variant,
  selectedConsultKey,
  onPick,
  className,
  style,
  tabIndex,
}: {
  consults: MockConsult[];
  variant: "lane" | "track" | "chip";
  selectedConsultKey: string | null;
  onPick: (key: string) => void;
  className?: string;
  style?: CSSProperties;
  tabIndex?: number;
}) {
  const [open, setOpen] = useState(false);
  const worst = worstOf(consults);
  const isSelected = consults.some((c) => c.key === selectedConsultKey);
  const n = consults.length;
  const tone =
    severity(worst) === 3
      ? "text-rose-700 dark:text-rose-300"
      : severity(worst) === 2
        ? "text-amber-700 dark:text-amber-300"
        : "text-muted-foreground";
  const chipTone =
    severity(worst) === 3
      ? "border-rose-500/40 bg-rose-500/10 hover:bg-rose-500/20"
      : severity(worst) === 2
        ? "border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20"
        : "border-border bg-card hover:bg-muted hover:text-foreground";
  const label =
    n === 1
      ? `Guardrail check ${worst.externalName}: ${DECISION_TONE[worst.decision].label}. Open details.`
      : `${n} guardrail checks${worst.decision === "blocked" ? ", one blocked" : ""}. Pick one to open.`;
  const button = (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-label={label}
      onKeyDown={stopKeys}
      onClick={n === 1 ? () => onPick(worst.key) : undefined}
      className={cn(
        "pointer-events-auto inline-flex cursor-pointer items-center justify-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
        variant === "chip"
          ? cn(
              "h-6 gap-1 rounded-md border px-1.5 text-[11px] font-medium tabular-nums",
              chipTone,
              tone,
            )
          : cn(
              "h-5 min-w-5 gap-0.5 rounded-md px-0.5 hover:bg-muted hover:ring-1 hover:ring-border",
              tone,
            ),
        isSelected && "bg-primary/15 ring-2 ring-primary hover:ring-primary",
        className,
      )}
      style={style}
    >
      <DecisionIcon
        consult={worst}
        className={variant === "track" ? "size-3" : "size-3.5"}
      />
      {variant === "chip" ? (
        <>
          <span className="lg:hidden">{n}</span>
          <span className="hidden lg:inline">
            {n} {n === 1 ? "check" : "checks"}
          </span>
        </>
      ) : variant === "lane" && n > 1 ? (
        <span className="text-[10px] leading-none font-semibold tabular-nums">
          {n}
        </span>
      ) : null}
    </button>
  );
  if (n === 1) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent className="max-w-64">
          <ConsultSummary consult={worst} />
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{button}</PopoverTrigger>
      <PopoverContent
        className="w-80 p-1"
        align="center"
        onKeyDown={stopKeys}
      >
        <p className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
          {n} guardrail checks · pick one to see its details below
        </p>
        <ul className="max-h-72 space-y-0.5 overflow-auto">
          {consults.map((consult) => (
            <li key={consult.key}>
              <ConsultListItem
                consult={consult}
                selected={consult.key === selectedConsultKey}
                onPick={() => {
                  onPick(consult.key);
                  setOpen(false);
                }}
              />
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function ConsultSummary({ consult }: { consult: MockConsult }) {
  return (
    <span className="block">
      <span className="block font-medium">
        {consult.externalName} · {DECISION_TONE[consult.decision].label}
      </span>
      <span className="block opacity-80">
        {ROLE_LABEL[consult.role]}{" "}
        {consult.beforeCall ? "before" : "on the result of"}{" "}
        {consult.toolName ?? "the session"} ·{" "}
        {formatLatency(consult.durationMs)}
      </span>
      <span className="block opacity-80">{consult.answer}</span>
      <span className="mt-0.5 block opacity-60">Click to open details</span>
    </span>
  );
}

function ConsultListItem({
  consult,
  selected,
  onPick,
}: {
  consult: MockConsult;
  selected: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onPick}
      onKeyDown={stopKeys}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
        selected && "bg-primary/10 ring-1 ring-primary/50",
      )}
    >
      <DecisionIcon consult={consult} />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-mono">{consult.externalName}</span>
        <span className="block truncate text-[11px] text-muted-foreground">
          {ROLE_LABEL[consult.role]} ·{" "}
          {consult.beforeCall ? "before" : "on the result of"}{" "}
          {consult.toolName ?? "the session"}
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
    </button>
  );
}

/**
 * A guarded tool call's marks, laid over its row: on wide screens a shield
 * before the bar for gate checks and after it for checks on the result; on
 * every screen a chip with the count in the (otherwise empty) Cost cell.
 */
function RowGuardOverlay({
  span,
  layout,
  checks,
  before,
  after,
  selectedConsultKey,
  onPick,
}: {
  span: ToolCallSpan;
  layout: Layout;
  checks: MockConsult[];
  before: MockConsult[];
  after: MockConsult[];
  selectedConsultKey: string | null;
  onPick: (key: string) => void;
}) {
  const chip = (
    <ConsultMark
      variant="chip"
      consults={checks}
      selectedConsultKey={selectedConsultKey}
      onPick={onPick}
    />
  );
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 grid",
        GRIDS[layout],
      )}
    >
      <div />
      <div className="relative mx-2 lg:mx-3">
        <span className="hidden lg:contents">
          {before.length > 0 ? (
            <ConsultMark
              variant="track"
              consults={before}
              selectedConsultKey={selectedConsultKey}
              onPick={onPick}
              tabIndex={-1}
              className="absolute top-1/2 -translate-y-1/2"
              style={{ right: `calc(${(1 - span.x) * 100}% + 1px)` }}
            />
          ) : null}
          {after.length > 0 ? (
            <ConsultMark
              variant="track"
              consults={after}
              selectedConsultKey={selectedConsultKey}
              onPick={onPick}
              tabIndex={-1}
              className="absolute top-1/2 -translate-y-1/2"
              style={{
                left: `calc(${span.x * 100}% + max(5px, ${span.w * 100}%) + 1px)`,
              }}
            />
          ) : null}
        </span>
        {layout === "tools" ? (
          <span className="absolute top-1/2 right-0 -translate-y-1/2">
            {chip}
          </span>
        ) : null}
      </div>
      {layout === "trace" ? (
        <>
          <div className="hidden lg:block" />
          <div className="flex items-center justify-end pr-3">{chip}</div>
        </>
      ) : (
        <div />
      )}
    </div>
  );
}

/** Phones: the label in force down the row's left edge, trust then audience. */
function LabelGutter({ label }: { label: LabelState }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-[5px] flex w-[7px] gap-px lg:hidden"
    >
      <span
        className={cn(
          "w-[3px]",
          TRUST_TONE[label.trust].bar,
          isQuiet("trust", label.trust) && "opacity-30",
        )}
      />
      <span
        className={cn(
          "w-[3px]",
          AUDIENCE_TONE[label.audience].bar,
          isQuiet("audience", label.audience) && "opacity-30",
        )}
      />
    </span>
  );
}

function DiffWords({ diffs }: { diffs: LabelDiff[] }) {
  return (
    <>
      {diffs.map((diff, i) => {
        const tone = laneTone(diff.lane, diff.to);
        return (
          <span key={diff.lane} className="inline-flex items-center gap-1">
            {i > 0 ? (
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            ) : null}
            <span className="text-muted-foreground">{LANE_NAME[diff.lane]}</span>
            <span aria-hidden="true" className="text-muted-foreground/60">
              →
            </span>
            <span className={cn("font-medium", tone.text)}>{tone.label}</span>
          </span>
        );
      })}
    </>
  );
}

/** Phones: a divider row where the label changes, selecting its cause. */
function ChangeBanner({
  change,
  selected,
  onPick,
}: {
  change: LabelChange;
  selected: boolean;
  onPick: () => void;
}) {
  const cause = change.segment.cause;
  return (
    <li className="relative lg:hidden">
      <button
        type="button"
        onClick={onPick}
        onKeyDown={stopKeys}
        className={cn(
          "flex h-8 w-full cursor-pointer items-center gap-1.5 border-b border-border/40 bg-muted/50 pr-4 pl-5 text-left text-[11px] whitespace-nowrap outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
          selected && "bg-primary/[0.07]",
        )}
      >
        <DiffWords diffs={change.diffs} />
        {cause?.toolName ? (
          <span className="min-w-0 truncate font-mono text-[10px] text-muted-foreground/80">
            {cause.kind === "reset" ? "reset" : `by ${cause.toolName}`}
          </span>
        ) : null}
        <ChevronRight
          className="ml-auto size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
      </button>
      <LabelGutter label={change.segment} />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-[3px] size-[11px] -translate-y-1/2 rounded-full border-2 border-card bg-foreground"
      />
    </li>
  );
}

/** Phones: the label in one line, opening the list of its changes. */
function PhoneLabelSummary({
  guard,
  origin,
  selectedConsultKey,
  onPickChange,
  onPickConsult,
}: {
  guard: GuardView;
  origin: number;
  selectedKey: string | null;
  selectedConsultKey: string | null;
  onPickChange: (change: LabelChange) => void;
  onPickConsult: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { current, first, changes } = guard;
  const attention = [...guard.blocked, ...guard.issues].sort(
    (a, b) => a.start - b.start,
  );
  return (
    <div className="border-b lg:hidden">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex h-10 w-full cursor-pointer items-center gap-1.5 px-4 text-left text-xs whitespace-nowrap outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
      >
        <ShieldCheck
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="text-muted-foreground">Label:</span>
        <span className={cn("font-medium", TRUST_TONE[current.trust].text)}>
          {TRUST_TONE[current.trust].label}
        </span>
        <span aria-hidden="true" className="text-muted-foreground/50">
          ·
        </span>
        <span
          className={cn("font-medium", AUDIENCE_TONE[current.audience].text)}
        >
          {AUDIENCE_TONE[current.audience].label}
        </span>
        <span aria-hidden="true" className="text-muted-foreground/50">
          ·
        </span>
        <span className="min-w-0 truncate text-muted-foreground">
          {changes.length} {changes.length === 1 ? "change" : "changes"}
        </span>
        {guard.blocked.length > 0 ? (
          <span className="shrink-0 rounded-sm bg-rose-500/10 px-1 text-[10px] leading-4 font-medium text-rose-700 dark:text-rose-300">
            {guard.blocked.length} blocked
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-180",
          )}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <div className="border-t bg-muted/30 pb-2">
          <p className="px-4 pt-2.5 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Label changes
          </p>
          <ol>
            <li className="flex min-h-9 items-center gap-3 px-4 text-xs text-muted-foreground">
              <span className="w-14 shrink-0 text-[11px] tabular-nums">
                Start
              </span>
              <span>
                {TRUST_TONE[first.trust].label} ·{" "}
                {AUDIENCE_TONE[first.audience].label}
              </span>
            </li>
            {changes.map((change) => (
              <li key={change.segment.start}>
                <button
                  type="button"
                  onClick={() => {
                    onPickChange(change);
                    setOpen(false);
                  }}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-4 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
                >
                  <span className="w-14 shrink-0 text-[11px] text-muted-foreground tabular-nums">
                    +{formatElapsed(change.segment.start - origin)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-1 text-xs">
                      <DiffWords diffs={change.diffs} />
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {change.segment.cause?.summary}
                    </span>
                  </span>
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ol>
          {attention.length > 0 ? (
            <>
              <p className="px-4 pt-3 pb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Checks to review
              </p>
              <ul className="space-y-0.5 px-2">
                {attention.map((consult) => (
                  <li key={consult.key}>
                    <ConsultListItem
                      consult={consult}
                      selected={consult.key === selectedConsultKey}
                      onPick={() => {
                        onPickConsult(consult.key);
                        setOpen(false);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <p className="px-4 pt-2 text-[11px] text-muted-foreground">
            Every check is also on its tool call's row: tap the shield to open
            it below.
          </p>
        </div>
      ) : null}
    </div>
  );
}
