"use client";
// design-arena: do not commit

import {
  ChevronRight,
  CornerDownRight,
  Flag,
  MessageSquareText,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
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

  // Guardrails: each tool call's checks, and the label changes placed before
  // the row they happen ahead of (or after the last row).
  const consultsByCall = useMemo(() => {
    const map = new Map<string, MockConsult[]>();
    for (const consult of guardrails?.consults ?? []) {
      if (!consult.toolCallKey) continue;
      const list = map.get(consult.toolCallKey) ?? [];
      list.push(consult);
      map.set(consult.toolCallKey, list);
    }
    return map;
  }, [guardrails]);
  const labelChanges = useMemo(
    () => placeLabelChanges(spans, guardrails),
    [spans, guardrails],
  );
  const pageChecks = useMemo(() => {
    let checks = 0;
    let blocked = 0;
    for (const span of spans) {
      for (const c of consultsByCall.get(span.key) ?? []) {
        checks++;
        if (c.decision === "blocked") blocked++;
      }
    }
    return { checks, blocked };
  }, [spans, consultsByCall]);
  const currentLabel = guardrails
    ? labelForRow(guardrails.labels, selected)
    : null;

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
        {currentLabel ? (
          <div className="flex min-w-0 items-center">
            <CurrentLabelBadge
              segment={currentLabel}
              atSelection={selected !== null}
              selectedKey={selectedKey}
              onSelect={onSelect}
            />
          </div>
        ) : null}
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
                  const checks = consultsByCall.get(span.key);
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
                    gutter: guardrails
                      ? guardrails.labelAt(span.start).trust
                      : null,
                    trailing:
                      checks && onSelectConsult ? (
                        <ConsultChip
                          consults={checks}
                          rowSelected={span.key === selectedKey}
                          selectedConsultKey={selectedConsultKey}
                          onSelectConsult={onSelectConsult}
                        />
                      ) : null,
                  };
                  return [
                    ...(labelChanges.before.get(span.key) ?? []).map(
                      (change) => (
                        <LabelChangeRow
                          key={`label-${change.segment.start}`}
                          change={change}
                          grid={grid}
                          selectedKey={selectedKey}
                          onSelect={onSelect}
                        />
                      ),
                    ),
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
                    ),
                  ];
                })}
                {labelChanges.after.map((change) => (
                  <LabelChangeRow
                    key={`label-${change.segment.start}`}
                    change={change}
                    grid={grid}
                    selectedKey={selectedKey}
                    onSelect={onSelect}
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
              guardrails={
                guardrails
                  ? {
                      checks: pageChecks.checks,
                      blocked: pageChecks.blocked,
                      changes:
                        labelChanges.after.length +
                        [...labelChanges.before.values()].reduce(
                          (n, list) => n + list.length,
                          0,
                        ),
                    }
                  : null
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
  guardrails: { checks: number; blocked: number; changes: number } | null;
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
  if (guardrails && guardrails.checks > 0) {
    parts.push({
      key: "guardrails",
      text: (
        <span>
          {guardrails.checks} guardrail{" "}
          {guardrails.checks === 1 ? "check" : "checks"}
          {guardrails.blocked > 0 ? (
            <span className="text-rose-700 dark:text-rose-300">
              {" "}
              ({guardrails.blocked} blocked)
            </span>
          ) : null}
          {guardrails.changes > 0
            ? ` · ${guardrails.changes} label ${guardrails.changes === 1 ? "change" : "changes"}`
            : null}
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
  /** Phones: the trust in force at the row's start, as a left gutter. */
  gutter?: Trust | null;
  /** Clickable guardrail checks, laid over the end of the name cell. */
  trailing?: ReactNode;
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
  gutter = null,
  trailing = null,
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
    <li className="relative">
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={label}
        className={cn(
          "group relative grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
          grid,
          selected
            ? "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]"
            : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {gutter ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0 left-0 w-1 lg:hidden",
              GUTTER[gutter],
            )}
          />
        ) : null}
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        <span
          className={cn(
            "flex min-w-0 items-center gap-2 pl-4",
            trailing ? "pr-[60px]" : "pr-3",
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
      {/* A sibling of the row's button (buttons do not nest), laid over the
          end of the name cell. */}
      {trailing ? (
        <div className={cn("pointer-events-none absolute inset-0 grid", grid)}>
          <div className="flex items-center justify-end pr-3">
            <div className="pointer-events-auto">{trailing}</div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// ============================================================================
// Guardrails (arena)
// ============================================================================

type LabelChange = { segment: LabelSegment; previous: LabelSegment };

/** Phones' gutter: the trust in force, quiet when trusted. */
const GUTTER: Record<Trust, string> = {
  trusted: "bg-emerald-500/35 dark:bg-emerald-400/30",
  suspicious: "bg-rose-500 dark:bg-rose-400",
};

const CHANGE_TONE = {
  suspicious: {
    pill: "border-rose-500/40 bg-rose-500/10 text-rose-800 hover:bg-rose-500/20 dark:border-rose-400/40 dark:text-rose-200",
    line: "bg-rose-500 dark:bg-rose-400",
    row: "bg-rose-500/[0.04]",
  },
  trusted: {
    pill: "border-emerald-500/40 bg-emerald-500/10 text-emerald-800 hover:bg-emerald-500/20 dark:border-emerald-400/40 dark:text-emerald-200",
    line: "bg-emerald-500 dark:bg-emerald-400",
    row: "bg-emerald-500/[0.04]",
  },
  audience: {
    pill: "border-indigo-500/40 bg-indigo-500/10 text-indigo-800 hover:bg-indigo-500/20 dark:border-indigo-400/40 dark:text-indigo-200",
    line: "bg-indigo-500 dark:bg-indigo-400",
    row: "bg-indigo-500/[0.04]",
  },
};

/** Keys and clicks inside a chip or pill stay out of the list's stepping. */
const stop = (event: SyntheticEvent) => event.stopPropagation();

/**
 * Each label change on this page, before the first row that starts at or
 * after it. A change after the last row's start goes after the list.
 */
function placeLabelChanges(
  spans: TimelineSpan[],
  guardrails: GuardrailsData | null,
): { before: Map<string, LabelChange[]>; after: LabelChange[] } {
  const before = new Map<string, LabelChange[]>();
  const after: LabelChange[] = [];
  if (!guardrails || spans.length === 0) return { before, after };
  const first = spans[0].start;
  const last = Math.max(...spans.map((s) => s.end));
  guardrails.labels.forEach((segment, index) => {
    if (index === 0 || !segment.cause) return;
    if (segment.start <= first || segment.start > last) return;
    const change = { segment, previous: guardrails.labels[index - 1] };
    const next = spans.find((s) => s.start >= segment.start);
    if (!next) {
      after.push(change);
      return;
    }
    const list = before.get(next.key) ?? [];
    list.push(change);
    before.set(next.key, list);
  });
  return { before, after };
}

/**
 * The label a row leaves the session in: the one it caused, else the one in
 * force when it ended. No row: the session's last label.
 */
function labelForRow(
  labels: LabelSegment[],
  row: TimelineSpan | null,
): LabelSegment {
  const lastSegment = labels[labels.length - 1];
  if (!row) return lastSegment;
  return (
    labels.find((s) => s.cause?.toolCallKey === row.key) ??
    labels.find((s) => row.end >= s.start && row.end < s.end) ??
    lastSegment
  );
}

/** "Trust → Suspicious", "Audience → Internal", in that order. */
function describeChange({ segment, previous }: LabelChange): string[] {
  const parts: string[] = [];
  if (segment.trust !== previous.trust)
    parts.push(`Trust → ${TRUST_TONE[segment.trust].label}`);
  if (segment.audience !== previous.audience)
    parts.push(`Audience → ${AUDIENCE_TONE[segment.audience].label}`);
  return parts;
}

function changeWhere(cause: NonNullable<LabelSegment["cause"]>): string {
  if (cause.kind === "reset") return "guardrails turned off";
  if (!cause.toolName) return cause.summary;
  return `${cause.kind === "released" ? "on" : "after"} ${cause.toolName}`;
}

/**
 * A slim divider exactly where the label moved: a pill that says what
 * changed and what caused it (click selects the cause), a mark on the axis
 * at the moment it moved, and the clock time.
 */
function LabelChangeRow({
  change,
  grid,
  selectedKey,
  onSelect,
}: {
  change: LabelChange;
  grid: string;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { segment } = change;
  const cause = segment.cause;
  if (!cause) return null;
  const parts = describeChange(change);
  const tone =
    CHANGE_TONE[
      segment.trust !== change.previous.trust ? segment.trust : "audience"
    ];
  const causeKey = cause.toolCallKey;
  const active = causeKey !== null && causeKey === selectedKey;
  const where = changeWhere(cause);
  const text = (
    <>
      <Flag className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="shrink-0 font-semibold">{parts.join(" · ")}</span>
      <span className="min-w-0 truncate font-normal opacity-80">
        · <span className={cn(cause.toolName && "font-mono")}>{where}</span>
      </span>
    </>
  );
  const pillClass = cn(
    "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full border px-2.5 text-[11px] leading-none transition-colors",
    tone.pill,
  );
  return (
    <li
      aria-label={`Label changed: ${parts.join(", ")}, ${where}`}
      className={cn(
        "relative grid h-9 border-b border-dashed border-border text-xs",
        grid,
        tone.row,
      )}
    >
      {/* Phones: the gutter takes the new label from here down. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 left-0 w-1 lg:hidden",
          GUTTER[segment.trust],
        )}
      />
      <div className="col-span-full flex min-w-0 items-center pr-4 pl-4 lg:col-span-1 lg:pr-3">
        <Tooltip>
          <TooltipTrigger asChild>
            {causeKey ? (
              <UnstyledButton
                onClick={() => onSelect(causeKey)}
                onKeyDown={stop}
                className={cn(
                  pillClass,
                  "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                  active && "ring-2 ring-primary/60",
                )}
              >
                {text}
                <ChevronRight
                  className="-mr-1 size-3 shrink-0 opacity-70"
                  aria-hidden="true"
                />
              </UnstyledButton>
            ) : (
              // biome-ignore lint/a11y/noNoninteractiveTabindex: design-arena: tooltip needs focus
              <span tabIndex={0} className={cn(pillClass, "cursor-default")}>
                {text}
              </span>
            )}
          </TooltipTrigger>
          <TooltipContent side="bottom" align="start" className="max-w-80">
            <p className="font-medium">{parts.join(" · ")}</p>
            <p className="opacity-80">{cause.summary}</p>
            <p className="mt-1 opacity-70">
              Now: {TRUST_TONE[segment.trust].label} ·{" "}
              {AUDIENCE_TONE[segment.audience].label}
              {causeKey ? ` · click to select ${cause.toolName}` : ""}
            </p>
          </TooltipContent>
        </Tooltip>
      </div>
      {/* The moment it moved, on the axis, with what it means. */}
      <div className="relative mx-3 hidden lg:block" aria-hidden="true">
        <span
          className={cn("absolute inset-y-0 w-0.5 -translate-x-1/2", tone.line)}
          style={{ left: `${segment.x * 100}%` }}
        />
        <span
          className={cn(
            "absolute top-1/2 max-w-[55%] -translate-y-1/2 truncate text-[11px] whitespace-nowrap text-muted-foreground",
          )}
          style={
            segment.x < 0.55
              ? { left: `calc(${segment.x * 100}% + 8px)` }
              : { right: `calc(${(1 - segment.x) * 100}% + 8px)` }
          }
        >
          {cause.summary}
        </span>
      </div>
      {grid === GRIDS.trace ? <div className="hidden lg:block" /> : null}
      <div className="hidden items-center justify-end pr-4 text-[11px] text-muted-foreground tabular-nums lg:flex">
        {formatDate({
          date: new Date(segment.start).toISOString(),
          dateFormat: "HH:mm:ss",
        })}
      </div>
    </li>
  );
}

/**
 * The toolbar's label: what the session is labeled at the selected row (or
 * at the end), in words. Click jumps to the call that set it.
 */
function CurrentLabelBadge({
  segment,
  atSelection,
  selectedKey,
  onSelect,
}: {
  segment: LabelSegment;
  atSelection: boolean;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const causeKey = segment.cause?.toolCallKey ?? null;
  const tone = TRUST_TONE[segment.trust];
  const body = (
    <>
      <Flag className={cn("size-3.5 shrink-0", tone.text)} aria-hidden="true" />
      <span className="text-muted-foreground">Label</span>
      <span className={cn("font-semibold", tone.text)}>{tone.label}</span>
      <span aria-hidden="true" className="text-muted-foreground/50">
        ·
      </span>
      <span
        className={cn("font-semibold", AUDIENCE_TONE[segment.audience].text)}
      >
        {AUDIENCE_TONE[segment.audience].label}
      </span>
      <span className="text-muted-foreground/70">
        {atSelection ? "after selected row" : "at end"}
      </span>
    </>
  );
  const className = cn(
    "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-xs whitespace-nowrap",
    segment.trust === "suspicious"
      ? "border-rose-500/40 bg-rose-500/[0.07]"
      : "bg-card",
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {causeKey && causeKey !== selectedKey ? (
          <UnstyledButton
            onClick={() => onSelect(causeKey)}
            className={cn(
              className,
              "cursor-pointer transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
            )}
          >
            {body}
          </UnstyledButton>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveTabindex: design-arena: tooltip needs focus
          <span tabIndex={0} className={className}>
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="max-w-80">
        <p>
          Trust: <b>{tone.label}</b> · Audience:{" "}
          <b>{AUDIENCE_TONE[segment.audience].label}</b>
        </p>
        <p className="opacity-80">
          {segment.cause
            ? segment.cause.summary
            : "The label the session started with."}
        </p>
        {causeKey && causeKey !== selectedKey ? (
          <p className="mt-1 opacity-70">
            Click to select {segment.cause?.toolName}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A tool call's guardrail checks: one shield opens its consult below; more
 * show a count and open a picker. The open consult's chip is ringed.
 */
function ConsultChip({
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
  const [open, setOpen] = useState(false);
  const worst =
    consults.find((c) => c.decision === "blocked") ??
    consults.find((c) => c.outcome !== "answered") ??
    consults[0];
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const active = consults.some((c) => c.key === selectedConsultKey);
  const className = cn(
    "inline-flex h-6 min-w-7 cursor-pointer items-center justify-center gap-1 rounded-md border px-1.5 text-[11px] font-semibold tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
    active
      ? "border-primary bg-primary/15 text-foreground ring-2 ring-primary/30"
      : blocked > 0
        ? "border-rose-500/50 bg-rose-500/10 text-rose-700 hover:bg-rose-500/20 dark:text-rose-300"
        : "border-border bg-card text-muted-foreground shadow-xs hover:border-foreground/30 hover:bg-muted hover:text-foreground",
  );
  const label = `${consults.length} guardrail ${consults.length === 1 ? "check" : "checks"}${blocked ? `, ${blocked} blocked` : ""}`;

  if (consults.length === 1) {
    const only = consults[0];
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            tabIndex={rowSelected ? 0 : -1}
            aria-label={`Open guardrail check ${only.externalName}: ${DECISION_TONE[only.decision].label}`}
            aria-pressed={active}
            onClick={() => onSelectConsult(only.key)}
            onKeyDown={stop}
            onDoubleClick={stop}
            className={className}
          >
            <DecisionIcon
              consult={only}
              className={cn("size-4", active && "text-primary")}
            />
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="left">
          <p className="font-medium">
            {only.externalName} · {DECISION_TONE[only.decision].label}
          </p>
          <p className="opacity-80">
            {ROLE_LABEL[only.role]} ·{" "}
            {only.beforeCall ? "before the call" : "on the result"} · click to
            open
          </p>
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <UnstyledButton
          tabIndex={rowSelected ? 0 : -1}
          aria-label={`${label}: choose one to open`}
          onKeyDown={stop}
          onDoubleClick={stop}
          className={cn(className, open && !active && "bg-muted")}
        >
          <DecisionIcon
            consult={worst}
            className={cn("size-4", active && "text-primary")}
          />
          <span>{consults.length}</span>
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-1"
        onKeyDown={stop}
        onClick={stop}
      >
        <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
          {label} · {consults[0].toolName}
        </p>
        <ul className="space-y-0.5">
          {consults.map((c) => {
            const current = c.key === selectedConsultKey;
            return (
              <li key={c.key}>
                <UnstyledButton
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    onSelectConsult(c.key);
                    setOpen(false);
                  }}
                  className={cn(
                    "flex min-h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-xs outline-none hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
                    current && "bg-primary/10",
                  )}
                >
                  <DecisionIcon consult={c} className="size-4" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono">
                      {c.externalName}
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {ROLE_LABEL[c.role]} ·{" "}
                      {c.beforeCall ? "before the call" : "on the result"} ·{" "}
                      {formatLatency(c.durationMs)}
                    </span>
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1 text-[10px] leading-4 font-medium",
                      DECISION_TONE[c.decision].chip,
                    )}
                  >
                    {DECISION_TONE[c.decision].label}
                  </span>
                  <ChevronRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </UnstyledButton>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
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
