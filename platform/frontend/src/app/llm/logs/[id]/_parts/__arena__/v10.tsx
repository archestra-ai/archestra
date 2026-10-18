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
  type Trust,
} from "./guardrails-mock";

import {
  CornerDownRight,
  MessageSquareText,
  ShieldCheck,
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

  const guard = useMemo(
    () => buildGuardIndex(guardrails, spans),
    [guardrails, spans],
  );
  const rowGuard = (span: TimelineSpan): RowGuard | null =>
    guard
      ? {
          label: guard.labelAt(span.start),
          change: guard.changeByRow.get(span.key) ?? null,
          consults: guard.consultsByTool.get(span.key) ?? [],
          selectedConsultKey,
          onSelectConsult: (key) => onSelectConsult?.(key),
          onSelectRow: onSelect,
        }
      : null;

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
            {guard ? (
              <>
                {/* Plain words for the two guardrail marks; the colours
                    never stand alone. */}
                <li className="hidden items-center gap-1.5 lg:inline-flex">
                  <ShieldCheck
                    className="size-3.5 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>Guardrail checks</span>
                  <span className="text-muted-foreground/70 tabular-nums">
                    {guard.consultCount}
                  </span>
                </li>
                <li className="hidden items-center gap-1.5 lg:inline-flex">
                  <span>Left edge:</span>
                  <span
                    className={cn("h-3 w-1 rounded-full", GUTTER.trusted)}
                    aria-hidden="true"
                  />
                  <span>Trusted</span>
                  <span
                    className={cn("h-3 w-1 rounded-full", GUTTER.suspicious)}
                    aria-hidden="true"
                  />
                  <span>Suspicious</span>
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
                  {/* Where the label switched: a faint line down the whole
                      list at the exact time, so the switch reads across
                      rows, not only on its own. */}
                  {guard?.changes.map((change) => (
                    <span
                      key={`label-change-${change.segment.start}`}
                      className={cn(
                        "absolute inset-y-0 hidden w-px opacity-30 lg:block",
                        change.tone.bar,
                      )}
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
                    guard: rowGuard(span),
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
            {guard ? (
              <span className="flex min-w-0 items-center gap-x-2 overflow-hidden">
                <StatusText
                  requests={spans.length - kindCounts.tool}
                  toolCalls={kindCounts.tool}
                  tokens={pageTotals.tokens}
                  billed={pageTotals.billed}
                  timeline={timeline}
                  compact
                />
                <LabelSummary
                  guard={guard}
                  selectedKey={selectedKey}
                  onSelect={onSelect}
                />
              </span>
            ) : (
              <StatusText
                requests={spans.length - kindCounts.tool}
                toolCalls={kindCounts.tool}
                tokens={pageTotals.tokens}
                billed={pageTotals.billed}
                timeline={timeline}
              />
            )}
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
  compact = false,
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
  /** Leave room for the label summary: span and idle only on 2xl. */
  compact?: boolean;
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
            compact &&
              (part.key === "span" || part.key === "idle" || part.key === "tokens") &&
              "lg:hidden 2xl:inline-flex",
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
  /** The row's label, label change and guardrail checks (arena only). */
  guard: RowGuard | null;
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
  guard,
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
  // A row with checks or a label change lays its own track out (chips,
  // duration and the change in one cluster beside the bar), so the plain
  // latency label steps aside for it.
  const decorated =
    guard !== null && (guard.consults.length > 0 || guard.change !== null);
  const latencyInButton = !decorated || latencyPlacement === "inside";
  const change = guard?.change ?? null;
  return (
    <li className={guard ? "relative" : undefined}>
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={
          guard
            ? `${label}, label ${labelName(guard.label)}${change ? `, ${change.long}` : ""}`
            : label
        }
        className={cn(
          "group grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
          grid,
          guard && "relative",
          selected
            ? guard
              ? // The label edge covers the first 4px; the selection mark
                // shows beside it.
                "bg-primary/[0.07] shadow-[inset_6px_0_0_var(--color-primary)]"
              : "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]"
            : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {/* The label edge: the session's label when this row started, one
            contiguous ribbon down the list. A dot marks the row that moved
            it. */}
        {guard ? (
          <>
            <span
              aria-hidden="true"
              title={`Label: ${labelName(guard.label)}`}
              className={cn(
                "absolute top-0 -bottom-px left-0 w-1",
                GUTTER[guard.label.trust],
              )}
            />
            {change ? (
              <span
                aria-hidden="true"
                className={cn(
                  "absolute top-1/2 left-0 size-2.5 -translate-y-1/2 rounded-full ring-2 ring-card",
                  change.tone.bar,
                )}
              />
            ) : null}
          </>
        ) : null}
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
              {/* Phones: the track is too narrow for the change marker, so
                  the change is said in words on the row's second line. */}
              {change ? (
                <span
                  className={cn(
                    "shrink-0 rounded-sm bg-current/10 px-1 text-[10px] leading-4 font-semibold lg:hidden",
                    change.tone.text,
                  )}
                >
                  {change.phone}
                </span>
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
          {latency && !tools && latencyInButton ? (
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
        <span
          className={cn(
            "flex items-center justify-end gap-1.5 pr-4 tabular-nums",
            // Phones put the row's shield chip here instead of the dash.
            !tools && guard && guard.consults.length > 0 && "max-lg:invisible",
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
      {guard && decorated ? (
        <RowGuardOverlay
          span={span}
          layout={layout}
          selected={selected}
          guard={guard}
          latency={latencyInButton ? null : latency}
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
// Guardrails (arena): label edge, change markers, shield chips, status summary
// ============================================================================

type LabelChange = {
  /** The segment the change opened. */
  segment: LabelSegment;
  /** The row that carries the marker: the cause, or the first row after it. */
  anchorKey: string | null;
  /** The check that set the label, when one did. */
  consult: MockConsult | null;
  /** "Trust → Suspicious", "Reset → Trusted · Public". */
  long: string;
  /** "→ Suspicious", for the status bar. */
  short: string;
  /** The phone row's second-line note. */
  phone: string;
  tone: { text: string; bar: string };
};

type GuardIndex = {
  consultsByTool: Map<string, MockConsult[]>;
  changes: LabelChange[];
  changeByRow: Map<string, LabelChange>;
  first: LabelState;
  consultCount: number;
  labelAt: (ms: number) => LabelState;
};

type RowGuard = {
  label: LabelState;
  change: LabelChange | null;
  consults: MockConsult[];
  selectedConsultKey: string | null;
  onSelectConsult: (key: string) => void;
  onSelectRow: (key: string) => void;
};

const GUTTER: Record<Trust, string> = {
  trusted: "bg-emerald-500/45 dark:bg-emerald-400/40",
  suspicious: "bg-rose-500 dark:bg-rose-400",
};

function labelName(state: LabelState): string {
  return `${TRUST_TONE[state.trust].label} · ${AUDIENCE_TONE[state.audience].label}`;
}

function buildGuardIndex(
  guardrails: GuardrailsData | null,
  spans: TimelineSpan[],
): GuardIndex | null {
  if (!guardrails) return null;
  const keys = new Set(spans.map((span) => span.key));
  const consultsByTool = new Map<string, MockConsult[]>();
  for (const consult of guardrails.consults) {
    if (!consult.toolCallKey || !keys.has(consult.toolCallKey)) continue;
    const list = consultsByTool.get(consult.toolCallKey) ?? [];
    list.push(consult);
    consultsByTool.set(consult.toolCallKey, list);
  }

  const changes: LabelChange[] = [];
  guardrails.labels.forEach((segment, index) => {
    const from = guardrails.labels[index - 1];
    const cause = segment.cause;
    if (!from || !cause) return;
    const reset = cause.kind === "reset";
    const trustMoved = segment.trust !== from.trust;
    const audienceMoved = segment.audience !== from.audience;
    if (!reset && !trustMoved && !audienceMoved) return;
    const trust = TRUST_TONE[segment.trust];
    const audience = AUDIENCE_TONE[segment.audience];
    const words = [
      trustMoved ? `Trust → ${trust.label}` : null,
      audienceMoved ? `Audience → ${audience.label}` : null,
    ].filter((word): word is string => word !== null);
    const long = reset ? `Reset → ${labelName(segment)}` : words.join(", ");
    const anchorKey =
      cause.toolCallKey && keys.has(cause.toolCallKey)
        ? cause.toolCallKey
        : (spans.find((span) => span.start >= segment.start)?.key ?? null);
    changes.push({
      segment,
      anchorKey,
      consult:
        guardrails.consults.find((c) => c.key === cause.consultKey) ?? null,
      long,
      short: reset
        ? `↺ ${labelName(segment)}`
        : `→ ${[trustMoved ? trust.label : null, audienceMoved ? audience.label : null].filter(Boolean).join(" · ")}`,
      phone: reset ? "Label reset" : long,
      tone:
        reset || trustMoved
          ? { text: trust.text, bar: trust.bar }
          : { text: audience.text, bar: audience.bar },
    });
  });

  const changeByRow = new Map<string, LabelChange>();
  for (const change of changes) {
    if (change.anchorKey) changeByRow.set(change.anchorKey, change);
  }
  return {
    consultsByTool,
    changes,
    changeByRow,
    first: guardrails.labels[0] ?? { trust: "trusted", audience: "public" },
    consultCount: guardrails.consults.length,
    labelAt: guardrails.labelAt,
  };
}

/**
 * The interactive layer over a decorated row, a sibling of the row button
 * (buttons cannot nest): shield chips beside the bar, the duration, the
 * label change marker at its exact time, and on phones one shield chip in
 * the last column.
 */
function RowGuardOverlay({
  span,
  layout,
  selected,
  guard,
  latency,
}: {
  span: TimelineSpan;
  layout: Layout;
  selected: boolean;
  guard: RowGuard;
  /** Set when the overlay, not the row, places the duration. */
  latency: { text: string; label: string } | null;
}) {
  const tools = layout === "tools";
  const { consults, change } = guard;
  const placement = placeLatency(span);
  const end = span.x + span.w;
  const before = consults.filter((c) => c.beforeCall);
  const after = consults.filter((c) => !c.beforeCall);
  // Phones' compressed track has no room; the tools layout's track is the
  // widest cell it has, so it keeps them.
  const shown = tools ? "flex" : "hidden lg:flex";
  const chip = (consult: MockConsult) => (
    <ConsultChip
      key={consult.key}
      consult={consult}
      selected={consult.key === guard.selectedConsultKey}
      onSelect={guard.onSelectConsult}
    />
  );
  const duration =
    latency && !tools ? (
      <span
        role="img"
        aria-label={latency.label}
        className={cn(
          "px-0.5 text-[11px] whitespace-nowrap tabular-nums",
          selected ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {latency.text}
      </span>
    ) : null;
  const pill = change ? <ChangePill change={change} guard={guard} /> : null;
  const leftOf = (children: ReactNode) => (
    <span
      className={cn(
        shown,
        "pointer-events-none absolute top-1/2 -translate-y-1/2 items-center gap-1",
      )}
      style={{ right: `calc(${(1 - span.x) * 100}% + 4px)` }}
    >
      {children}
    </span>
  );
  const rightOf = (children: ReactNode) => (
    <span
      className={cn(
        shown,
        "pointer-events-none absolute top-1/2 -translate-y-1/2 items-center gap-1",
      )}
      style={{
        left: `calc(max(${end * 100}%, ${span.x * 100}% + 5px) + 4px)`,
      }}
    >
      {children}
    </span>
  );
  const roomAfter = end <= 0.93;
  const primary =
    consults.find((c) => c.key === guard.selectedConsultKey) ??
    consults.find((c) => c.decision === "blocked") ??
    consults.find((c) => c.outcome !== "answered") ??
    consults[0];

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-0 grid",
        GRIDS[layout],
      )}
    >
      <div />
      <div className="relative mx-2 lg:mx-3">
        {change ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-1.5 w-0.5 -translate-x-1/2 rounded-full",
              tools ? "block" : "hidden lg:block",
              change.tone.bar,
            )}
            style={{ left: `${change.segment.x * 100}%` }}
          />
        ) : null}
        {placement === "after" ? (
          <>
            {before.length > 0 ? leftOf(before.map(chip)) : null}
            {rightOf(
              <>
                {after.map(chip)}
                {duration}
                {pill}
              </>,
            )}
          </>
        ) : placement === "before" ? (
          <>
            {leftOf(
              <>
                {pill}
                {duration}
                {before.map(chip)}
                {roomAfter ? null : after.map(chip)}
              </>,
            )}
            {roomAfter && after.length > 0 ? rightOf(after.map(chip)) : null}
          </>
        ) : (
          <>
            {consults.length > 0 ? leftOf(consults.map(chip)) : null}
            {pill ? (
              <span
                className={cn(
                  shown,
                  "pointer-events-none absolute top-1/2 -translate-y-1/2",
                )}
                style={
                  change && change.segment.x > 0.72
                    ? { right: `calc(${(1 - change.segment.x) * 100}% + 5px)` }
                    : { left: `calc(${(change?.segment.x ?? 0) * 100}% + 5px)` }
                }
              >
                {pill}
              </span>
            ) : null}
          </>
        )}
      </div>
      {tools ? null : <div className="hidden lg:block" />}
      <div className="flex items-center justify-end pr-3">
        {!tools && primary ? (
          <span className="flex lg:hidden">
            <ConsultChip
              consult={primary}
              count={consults.length}
              selected={consults.some(
                (c) => c.key === guard.selectedConsultKey,
              )}
              onSelect={guard.onSelectConsult}
            />
          </span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One guardrail check on a tool call: a shield in a 20px circle, coloured
 * only when it blocked or failed to answer. Opens the check below.
 */
function ConsultChip({
  consult,
  selected,
  onSelect,
  count = 1,
}: {
  consult: MockConsult;
  selected: boolean;
  onSelect: (key: string) => void;
  /** Phones show one chip for all of a call's checks. */
  count?: number;
}) {
  const decision = DECISION_TONE[consult.decision];
  const when = consult.beforeCall ? "before the call" : "on the result";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={() => onSelect(consult.key)}
          aria-pressed={selected}
          aria-label={`Guardrail check: ${ROLE_LABEL[consult.role]} ${consult.externalName}, ${decision.label.toLowerCase()} ${when}${count > 1 ? `, ${count} checks` : ""}. Open details`}
          className={cn(
            "pointer-events-auto relative inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full border bg-card shadow-xs outline-none transition-colors",
            "hover:border-foreground/40 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
            consult.decision === "blocked"
              ? "border-rose-500/60"
              : consult.outcome !== "answered"
                ? "border-amber-500/60"
                : "border-border",
            selected &&
              "border-primary bg-primary/15 ring-2 ring-primary/40 hover:border-primary hover:bg-primary/20",
          )}
        >
          <DecisionIcon
            consult={consult}
            className={cn(selected && "text-primary")}
          />
          {count > 1 ? (
            <span className="absolute -top-1.5 -right-1.5 min-w-3.5 rounded-full bg-foreground px-0.5 text-center text-[9px] leading-3.5 font-semibold text-background tabular-nums">
              {count}
            </span>
          ) : null}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">
            {ROLE_LABEL[consult.role]} · {consult.externalName}
            {count > 1 ? ` (+${count - 1} more)` : ""}
          </span>
          <span>
            {decision.label} {when} · {consult.answer}
          </span>
          <span className="opacity-70">
            {formatLatency(consult.durationMs)} · Click for the check's details
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The label change on its cause row, in words. Opens the check that set the
 * label, or selects the row when no check did (a release, a reset).
 */
function ChangePill({
  change,
  guard,
}: {
  change: LabelChange;
  guard: RowGuard;
}) {
  const { consult } = change;
  const active = consult !== null && consult.key === guard.selectedConsultKey;
  const open = () => {
    if (consult) guard.onSelectConsult(consult.key);
    else if (change.anchorKey) guard.onSelectRow(change.anchorKey);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          onClick={open}
          aria-pressed={consult ? active : undefined}
          aria-label={`${change.long}. ${change.segment.cause?.summary ?? ""}. ${consult ? "Open the check that set it" : "Select the call that caused it"}`}
          className={cn(
            "pointer-events-auto inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-sm border border-current/30 bg-card px-1.5 text-[11px] leading-none font-medium whitespace-nowrap shadow-xs outline-none transition-colors",
            "hover:border-current/60 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/60",
            change.tone.text,
            active && "border-primary ring-2 ring-primary/40",
          )}
        >
          {change.long}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <div className="flex flex-col gap-0.5">
          <span className="font-medium">Label is now {labelName(change.segment)}</span>
          <span>{change.segment.cause?.summary}</span>
          <span className="opacity-70">
            {consult
              ? `Set by ${consult.externalName} · click for the check's details`
              : "Click to select the call that caused it"}
          </span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The status bar's label story: where it started, then each change as a
 * link to the row that caused it.
 */
function LabelSummary({
  guard,
  selectedKey,
  onSelect,
}: {
  guard: GuardIndex;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { changes, first } = guard;
  return (
    <span className="hidden min-w-0 items-center gap-1.5 overflow-hidden lg:inline-flex">
      <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />
      <span className="shrink-0">Label:</span>
      <span className="shrink-0 font-medium text-foreground/80">
        {labelName(first)}
      </span>
      {changes.map((change) => (
        <Tooltip key={`summary-${change.segment.start}`}>
          <TooltipTrigger asChild>
            <UnstyledButton
              disabled={!change.anchorKey}
              onClick={() => change.anchorKey && onSelect(change.anchorKey)}
              aria-label={`${change.long}: select ${change.segment.cause?.toolName ?? "the row"}`}
              className={cn(
                "shrink-0 cursor-pointer rounded-sm px-0.5 font-medium underline decoration-dotted decoration-1 underline-offset-[3px] outline-none transition-colors",
                "hover:bg-accent hover:decoration-solid focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default",
                change.tone.text,
                change.anchorKey !== null &&
                  change.anchorKey === selectedKey &&
                  "bg-primary/10 decoration-solid",
              )}
            >
              {change.short}
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-72">
            <div className="flex flex-col gap-0.5">
              <span className="font-medium">{change.long}</span>
              <span>{change.segment.cause?.summary}</span>
              <span className="opacity-70">
                {change.segment.cause?.toolName
                  ? `Caused by ${change.segment.cause.toolName} · click to select it`
                  : "Click to select the row"}
              </span>
            </div>
          </TooltipContent>
        </Tooltip>
      ))}
      <span className="shrink-0 text-muted-foreground/70">
        ({changes.length} {changes.length === 1 ? "change" : "changes"})
      </span>
    </span>
  );
}
