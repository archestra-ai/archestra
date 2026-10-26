"use client";

import { CornerDownRight, MessageSquareText } from "lucide-react";
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
  buildEntries,
  ChangeNote,
  ConsultRow,
  type Entry,
  GuardrailsBar,
  type GutterProps,
  gutterWords,
  type LabelChange,
  LabelGutter,
  pageChanges,
  pageConsults,
  SELECTED_EDGE,
  SELECTED_PAST_GUTTER,
} from "./guardrail-rows";
import type { GuardrailsData, TraceYell } from "./guardrails";
import {
  type InteractionSummary,
  type RequestSpan,
  requestLabel,
  SPAN_KINDS,
  type SpanKind,
  type Timeline,
  type TimelineSpan,
  type ToolCallSpan,
} from "./session-timeline";
import { StatusBarPagination } from "./status-bar-pagination";
import { GRIDS, type Layout, WIDE_ONLY } from "./waterfall-grid";
import { YellChip, YellRowMarks } from "./yell-markers";

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
  /** The session's guardrail checks and label history, when OpenAPPA is on. */
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

  // Every row the list draws, in order: requests and tool calls, and each
  // tool call's checks just above (gates) and below (result checks) it.
  // Label changes add no rows: the gutter carries them.
  const entries = useMemo(
    () => buildEntries({ spans, guardrails }),
    [spans, guardrails],
  );
  const steppable = entries;
  const changes = useMemo(
    () => (guardrails ? pageChanges({ entries, guardrails }) : []),
    [entries, guardrails],
  );
  const { notesByKey, nodesByKey } = useMemo(() => {
    const notes = new Map<string, LabelChange[]>();
    const nodes = new Map<
      string,
      { top: LabelChange[]; bottom: LabelChange[] }
    >();
    for (const change of changes) {
      notes.set(change.noteKey, [...(notes.get(change.noteKey) ?? []), change]);
      const node = nodes.get(change.nodeKey) ?? { top: [], bottom: [] };
      node[change.nodeAt].push(change);
      nodes.set(change.nodeKey, node);
    }
    return { notesByKey: notes, nodesByKey: nodes };
  }, [changes]);
  const openConsult =
    selectedConsultKey && guardrails
      ? (guardrails.consults.find((c) => c.key === selectedConsultKey) ?? null)
      : null;
  /** A consult row is the selection when it is open and drawn. */
  const consultRowSelected =
    openConsult !== null &&
    entries.some(
      (entry) =>
        entry.type === "consult" && entry.consult.key === openConsult.key,
    );
  const consultsOnPage = useMemo(
    () =>
      entries.length === 0 || !guardrails
        ? []
        : pageConsults({ spans, guardrails }),
    [entries, spans, guardrails],
  );
  const labelHere = guardrails
    ? guardrails.labelAt(
        openConsult?.start ??
          selected?.start ??
          Math.max(0, ...spans.map((span) => span.end)),
      )
    : null;
  const labelHereName = openConsult
    ? openConsult.externalName
    : selected
      ? "selected row"
      : "end of page";
  const focusKey = consultRowSelected ? selectedConsultKey : selectedKey;
  // A change selects what caused it: the tool call (its details say why the
  // label changed), else the check, else the first row under the new label.
  const activateChange = (change: LabelChange) => {
    if (change.target.type === "consult") onSelectConsult?.(change.target.key);
    else onSelect(change.target.key);
  };
  const yellByKey = new Map(
    (guardrails?.yells ?? []).flatMap((yell) =>
      yell.toolCallKey ? [[yell.toolCallKey, yell] as const] : [],
    ),
  );
  const yellsOnPage = spans.flatMap((span) => {
    const yell = yellByKey.get(span.key);
    return yell ? [yell] : [];
  });
  const isChangeActive = (change: LabelChange) =>
    change.target.type === "consult"
      ? change.target.key === selectedConsultKey
      : !selectedConsultKey && change.target.key === selectedKey;
  const gutterFor = (entry: Entry, index: number): GutterProps | null =>
    entry.gutter
      ? {
          label: entry.gutter,
          odd: index % 2 === 1,
          nodes: nodesByKey.get(entry.key) ?? null,
          isChangeActive,
          onActivateChange: activateChange,
        }
      : null;
  const edges = consultRowSelected && openConsult ? openConsult : selected;
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

  // Keep the selection in view inside the list when it changes from outside
  // it (the details pane's stepper, a page change landing on a new default,
  // a link to one tool call). Only the list scrolls: moving the page would
  // yank a reader who is looking at the details pane.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const row = focusKey ? rowRefs.current.get(focusKey) : undefined;
    if (scroller && row) scrollWithin(scroller, row);
  }, [focusKey]);

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

  // The arrows step through checks too, so a gate or a result check opens
  // in the pane below the same way a row does.
  const moveTo = (index: number) => {
    const target = steppable[index];
    if (!target) return;
    if (target.type === "consult") {
      onSelectConsult?.(target.consult.key);
      rowRefs.current.get(target.consult.key)?.focus({ preventScroll: true });
      return;
    }
    onSelect(target.span.key);
    rowRefs.current.get(target.span.key)?.focus({ preventScroll: true });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLOListElement>) => {
    const current = steppable.findIndex((entry) =>
      entry.type === "consult"
        ? consultRowSelected && entry.consult.key === selectedConsultKey
        : !consultRowSelected && entry.span.key === selectedKey,
    );
    const targets: Record<string, number> = {
      ArrowDown: current + 1,
      ArrowUp: current - 1,
      Home: 0,
      End: steppable.length - 1,
    };
    if (!(event.key in targets)) return;
    event.preventDefault();
    moveTo(Math.min(steppable.length - 1, Math.max(0, targets[event.key])));
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
          legend below, wrapping onto more lines when it runs out of room.
          Wide: one row, the legend and the action at the right end. */}
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
            className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
          >
            {(Object.keys(SPAN_KINDS) as SpanKind[])
              .filter((kind) => !hideEmptyKinds || kindCounts[kind] > 0)
              .map((kind) => (
                <li
                  key={kind}
                  className={cn(
                    "inline-flex items-center gap-1.5 whitespace-nowrap",
                    // An empty kind is still a key to the colours.
                    kindCounts[kind] === 0 && "opacity-40",
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
            <span className="ml-1">to step</span>
          </span>
        </div>
      </header>
      {guardrails ? (
        <GuardrailsBar
          consults={consultsOnPage}
          changes={changes}
          activeChange={changes.findIndex(isChangeActive)}
          onActivateChange={activateChange}
          label={labelHere}
          labelName={labelHereName}
          yells={yellsOnPage}
          selectedKey={consultRowSelected ? null : selectedKey}
          onSelectYell={(yell) => {
            if (yell.toolCallKey) onSelect(yell.toolCallKey);
          }}
        />
      ) : null}
      {notice}

      {/* Only sideways scrolling is contained: containing vertical overscroll
          swallowed the wheel even when the list had nothing to scroll, so the
          page under the pointer would not move. */}
      <div
        ref={scrollerRef}
        className="max-h-[50svh] overflow-auto overscroll-x-contain lg:max-h-[440px]"
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
                  {edges ? (
                    <>
                      <span
                        className="absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
                        style={{ left: `${edges.x * 100}%` }}
                      />
                      <span
                        className="absolute inset-y-0 z-10 border-l border-dashed border-primary/60"
                        style={{
                          left: `${(edges.x + edges.w) * 100}%`,
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
                {entries.map((entry, index) => {
                  if (entry.type === "consult") {
                    const { consult } = entry;
                    const isSelected =
                      consultRowSelected && consult.key === selectedConsultKey;
                    return (
                      <ConsultRow
                        key={entry.key}
                        layout={layout}
                        consult={consult}
                        toolSpan={entry.toolSpan}
                        gutter={gutterFor(entry, index)}
                        note={notesByKey.get(entry.key) ?? null}
                        selected={isSelected}
                        buttonRef={(el) => {
                          if (el) rowRefs.current.set(consult.key, el);
                          else rowRefs.current.delete(consult.key);
                        }}
                        onSelect={() => onSelectConsult?.(consult.key)}
                      />
                    );
                  }
                  const { span } = entry;
                  const rowProps = {
                    layout,
                    selected: span.key === selectedKey && !consultRowSelected,
                    ancestor: span.key === selectedKey && consultRowSelected,
                    gutter: gutterFor(entry, index),
                    note: notesByKey.get(entry.key) ?? null,
                    yell: yellByKey.get(span.key) ?? null,
                    guardrailsOffAt: guardrails?.guardrailsOffAt ?? null,
                    highlighted: span.key === highlightedKey,
                    buttonRef: (el: HTMLButtonElement | null) => {
                      if (el) rowRefs.current.set(span.key, el);
                      else rowRefs.current.delete(span.key);
                    },
                    onSelect: () => onSelect(span.key),
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
          {/* Every figure here is this page's, not the session's: the facts
              card above has the session totals. */}
          <span className="hidden text-muted-foreground/80 lg:inline">
            This page:{" "}
          </span>
          {requests.toLocaleString()} {requests === 1 ? "request" : "requests"}
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
        <Tooltip>
          <TooltipTrigger asChild>
            <UnstyledButton className="cursor-default underline decoration-muted-foreground/40 decoration-dotted underline-offset-2">
              {formatElapsed(
                timeline.breaks.reduce((sum, b) => sum + b.gapMs, 0),
              )}{" "}
              idle, shortened
            </UnstyledButton>
          </TooltipTrigger>
          <TooltipContent className="max-w-64 px-2 py-1.5">
            {timeline.breaks.length === 1
              ? "One stretch with no activity"
              : `${timeline.breaks.length} stretches with no activity`}{" "}
            is drawn as a narrow hatched band, so the busy parts of the timeline
            keep their width.
          </TooltipContent>
        </Tooltip>
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
  /** Its check is the selection: the row reads as that check's parent. */
  ancestor?: boolean;
  /** The label gutter at the row's left edge (and its change nodes). */
  gutter?: GutterProps | null;
  /** Label changes this row caused, noted on its detail line. */
  note?: LabelChange[] | null;
  /** The yell this row's call sent. */
  yell?: TraceYell | null;
  /** When a superyell turned guardrails off, epoch ms. */
  guardrailsOffAt?: number | null;
  highlighted: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
};

/** One row's frame and track; the cells around the track vary by kind. */
function RowShell({
  span,
  label,
  layout,
  selected,
  ancestor = false,
  gutter = null,
  note = null,
  yell = null,
  guardrailsOffAt = null,
  highlighted,
  buttonRef,
  onSelect,
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
  const off =
    Boolean(yell?.superyell) ||
    (guardrailsOffAt !== null && span.start >= guardrailsOffAt);
  return (
    <li className="relative">
      {yell || off ? (
        <YellRowMarks
          yell={yell}
          off={off}
          guardrailsOffAt={guardrailsOffAt}
          hasGutter={Boolean(gutter)}
          selected={selected}
          onSelectRow={onSelect}
        />
      ) : null}
      {gutter ? <LabelGutter {...gutter} onSelectRow={onSelect} /> : null}
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        aria-label={`${label}${gutterWords(gutter, note)}${off ? ", guardrails off" : ""}`}
        className={cn(
          "group grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-10",
          grid,
          selected
            ? cn(
                "bg-primary/[0.07]",
                gutter ? SELECTED_PAST_GUTTER : SELECTED_EDGE,
              )
            : ancestor
              ? "bg-primary/[0.035] hover:bg-primary/[0.06]"
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
              {note && note.length > 0 ? <ChangeNote changes={note} /> : null}
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
  // A model pool writes one row per attempt; a failed one was retried on the
  // next member, in the row after it.
  const failedOver = row.attemptOutcome === "failed_over";

  return (
    <RowShell
      span={span}
      {...rowProps}
      label={`${label}, ${modelName}, ${latency}${failedOver ? ", failed over" : ""}${isConversation ? ", latest conversation" : ""}`}
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
          {failedOver ? (
            <span
              className="shrink-0 rounded-sm bg-red-500/10 px-1 text-[10px] leading-4 font-medium text-red-700 dark:text-red-400"
              title={row.failureReason ?? undefined}
            >
              Failed over
            </span>
          ) : null}
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
        // On a plan the figure is list price, never billed: dimmed behind the
        // same "Plan" tag the sessions list uses, so it reads the same here.
        <span
          className={cn(
            "inline-flex items-center gap-1",
            onPlan ? "text-muted-foreground" : "font-medium",
          )}
          title={
            onPlan
              ? "Covered by a subscription plan: list price, not billed"
              : undefined
          }
        >
          {onPlan ? (
            <span className="rounded-sm bg-muted px-1 text-[9px] leading-[14px] font-medium tracking-wide uppercase">
              Plan
            </span>
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
          {rowProps.yell ? <YellChip yell={rowProps.yell} /> : null}
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
