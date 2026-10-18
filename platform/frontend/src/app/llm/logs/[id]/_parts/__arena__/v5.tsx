"use client";

import {
  CornerDownRight,
  Flag,
  MessageSquareText,
  ShieldCheck,
} from "lucide-react";
import {
  type CSSProperties,
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
  const headerRef = useRef<HTMLDivElement>(null);

  // Guardrails: each tool call's checks, the label's switches (said in
  // words), and where each switch lands in the list for the phone dividers.
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
  const changes = useMemo(
    () => (guardrails ? describeChanges(guardrails.labels, spans) : []),
    [guardrails, spans],
  );
  const changesBefore = useMemo(() => {
    const map = new Map<string, LabelChange[]>();
    for (const change of changes) {
      if (!change.firstRowKey) continue;
      const list = map.get(change.firstRowKey) ?? [];
      list.push(change);
      map.set(change.firstRowKey, list);
    }
    return map;
  }, [changes]);
  const [hoveredChange, setHoveredChange] = useState<number | null>(null);
  const hovered = changes.find((change) => change.index === hoveredChange);
  const laneRef = useRef<HTMLDivElement>(null);
  const [laneWidth, setLaneWidth] = useState(640);
  useEffect(() => {
    const lane = laneRef.current;
    if (!lane || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0)
        setLaneWidth(entry.contentRect.width);
    });
    observer.observe(lane);
    return () => observer.disconnect();
  }, [guardrails, loading, spans.length]);
  const flags = useMemo(
    () => layoutFlags(changes, laneWidth),
    [changes, laneWidth],
  );
  const flagLevels = flags.reduce((max, f) => Math.max(max, f.level + 1), 1);
  const jumpTo = (change: LabelChange) => {
    const key = change.targetKey;
    if (!key) return;
    onSelect(key);
    rowRefs.current.get(key)?.focus({ preventScroll: true });
  };

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
      scrollWithin(scroller, row, headerRef.current?.offsetHeight ?? 32);
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
          {guardrails ? <GuardrailsLegend className="hidden lg:flex" /> : null}
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground xl:inline-flex">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            <span className="ml-1">to step · {openHint}</span>
          </span>
        </div>
        {guardrails ? <GuardrailsLegend className="flex lg:hidden" /> : null}
      </header>
      {notice}

      <div
        ref={scrollerRef}
        className="max-h-[50svh] overflow-auto overscroll-contain lg:max-h-[440px]"
      >
        <div className="lg:min-w-[920px]">
          {/* Column header and axis */}
          <div ref={headerRef} className="sticky top-0 z-[15]">
            <div
              className={cn(
                // Sticks within the list's own scroll box, above the markers.
                "grid h-8 border-b bg-muted text-[11px] font-medium text-muted-foreground",
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
            {guardrails && timeline && spans.length > 0 && !loading ? (
              <div
                className={cn(
                  "hidden border-b bg-card text-[11px] lg:grid",
                  grid,
                )}
                style={{ height: 8 + flagLevels * 24 }}
              >
                <div className="flex flex-col justify-center pl-4 leading-4">
                  <span className="font-medium text-foreground/80">
                    Label changes
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {changes.length === 0
                      ? `${describeState(guardrails.labels[0])} throughout`
                      : `Starts ${describeState(guardrails.labels[0])} · click a flag`}
                  </span>
                </div>
                <div ref={laneRef} className="relative mx-2 lg:mx-3">
                  <LabelZones labels={guardrails.labels} />
                  {flags.map((flag) => (
                    <ChangeFlag
                      key={flag.index}
                      flag={flag}
                      active={hoveredChange === flag.index}
                      onHover={setHoveredChange}
                      onJump={() => jumpTo(flag)}
                    />
                  ))}
                </div>
                {layout === "trace" ? (
                  <div className="hidden lg:block" />
                ) : null}
                <div />
              </div>
            ) : null}
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
                  {guardrails ? (
                    <span className="absolute inset-0 hidden lg:block">
                      <LabelZones labels={guardrails.labels} />
                      {changes.map((change) => (
                        <span
                          key={`boundary-${change.index}`}
                          className={cn(
                            "absolute inset-y-0 -translate-x-1/2 transition-[width,opacity] duration-100",
                            CHANGE_TONE[change.tone].line,
                            hoveredChange === change.index
                              ? "z-[5] w-[3px] opacity-100"
                              : "w-px opacity-70",
                          )}
                          style={{ left: `${change.seg.x * 100}%` }}
                        />
                      ))}
                    </span>
                  ) : null}
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
                {spans.flatMap((span) => {
                  const rowProps = {
                    layout,
                    selected: span.key === selectedKey,
                    highlighted: span.key === highlightedKey,
                    guard: guardrails
                      ? {
                          consults: consultsByCall.get(span.key) ?? [],
                          selectedConsultKey,
                          onSelectConsult,
                          label: guardrails.labelAt(span.start),
                          causeTone:
                            hovered?.targetKey === span.key
                              ? hovered.tone
                              : null,
                        }
                      : null,
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
                  const before = changesBefore.get(span.key) ?? [];
                  return [
                    ...before.map((change) => (
                      <PhoneChangeRow
                        key={`change-${change.index}`}
                        change={change}
                        onHover={setHoveredChange}
                        onJump={() => jumpTo(change)}
                      />
                    )),
                    row,
                  ];
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
              guardrails={guardrails}
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
  headerPx: number = COLUMN_HEADER_PX,
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
  guardrails,
}: {
  requests: number;
  toolCalls: number;
  tokens: number;
  billed: number;
  timeline: Timeline | null;
  guardrails: GuardrailsData | null;
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
  if (guardrails && guardrails.consults.length > 0) {
    const blocked = guardrails.consults.filter(
      (c) => c.decision === "blocked",
    ).length;
    parts.push({
      key: "checks",
      text: (
        <span className="inline-flex items-center gap-1">
          <ShieldCheck className="size-3" aria-hidden="true" />
          {guardrails.consults.length} guardrail checks
          {blocked > 0 ? (
            <span className="text-rose-700 dark:text-rose-300">
              · {blocked} blocked
            </span>
          ) : null}
        </span>
      ),
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
  guard: RowGuard | null;
};

type RowGuard = {
  consults: MockConsult[];
  selectedConsultKey: string | null;
  onSelectConsult?: (key: string | null) => void;
  /** The label in force when the row started (the phone gutter). */
  label: LabelState;
  /** Set while a flag for the switch this row caused is hovered. */
  causeTone: ChangeTone | null;
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
  const checksBefore = guard?.consults.filter((c) => c.beforeCall) ?? [];
  const checksAfter = guard?.consults.filter((c) => !c.beforeCall) ?? [];
  const gutter = guard ? gutterTone(guard.label) : null;
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
          guard?.causeTone && CHANGE_TONE[guard.causeTone].row,
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        {/* Phones: the label in force, as a gutter down the rows. */}
        {gutter ? (
          <span
            aria-hidden="true"
            className={cn(
              "absolute inset-y-0 left-0 w-1.5 lg:hidden",
              gutter.bar,
            )}
          />
        ) : null}
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
                      left: `calc(${(span.x + span.w) * 100}% + ${8 + checksAfter.length * SHIELD_PX}px)`,
                    }
                  : latencyPlacement === "before"
                    ? {
                        right: `calc(${(1 - span.x) * 100}% + ${6 + checksBefore.length * SHIELD_PX}px)`,
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
      {guard && guard.consults.length > 0 ? (
        <ShieldOverlay
          span={span}
          grid={grid}
          layout={layout}
          before={checksBefore}
          after={checksAfter}
          rowSelected={selected}
          selectedConsultKey={guard.selectedConsultKey}
          onSelectConsult={guard.onSelectConsult}
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
// Guardrails (arena)
// ============================================================================

/** What a label switch did: lowered trust, narrowed audience, or reset. */
type ChangeTone = "trust" | "audience" | "reset";

type LabelChange = {
  /** Index of the segment the switch starts. */
  index: number;
  seg: LabelSegment;
  /** The switch in words, e.g. "Trust → Suspicious". */
  text: string;
  tone: ChangeTone;
  /** First row at or after the switch: where the phone divider goes. */
  firstRowKey: string | null;
  /** The row a flag jumps to: the cause, else the first row after. */
  targetKey: string | null;
};

type PlacedFlag = LabelChange & { level: number; flip: boolean };

/** One shield's slot, so latency labels can step around them. */
const SHIELD_PX = 22;

const CHANGE_TONE: Record<
  ChangeTone,
  {
    line: string;
    flag: string;
    edgeLeft: string;
    edgeRight: string;
    active: string;
    row: string;
    soft: string;
    icon: string;
  }
> = {
  trust: {
    line: "bg-rose-500 dark:bg-rose-400",
    flag: "border-rose-500/40 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-400/40 dark:bg-rose-950 dark:text-rose-100 dark:hover:bg-rose-900",
    edgeLeft: "border-l-rose-500 dark:border-l-rose-400",
    edgeRight: "border-r-rose-500 dark:border-r-rose-400",
    active: "bg-rose-100 ring-2 ring-rose-500/30 dark:bg-rose-900",
    row: "bg-rose-500/10 ring-1 ring-rose-500/50 ring-inset",
    soft: "bg-rose-500/[0.07] dark:bg-rose-400/[0.08]",
    icon: "text-rose-600 dark:text-rose-400",
  },
  audience: {
    line: "bg-indigo-500 dark:bg-indigo-400",
    flag: "border-indigo-500/40 bg-indigo-50 text-indigo-800 hover:bg-indigo-100 dark:border-indigo-400/40 dark:bg-indigo-950 dark:text-indigo-100 dark:hover:bg-indigo-900",
    edgeLeft: "border-l-indigo-500 dark:border-l-indigo-400",
    edgeRight: "border-r-indigo-500 dark:border-r-indigo-400",
    active: "bg-indigo-100 ring-2 ring-indigo-500/30 dark:bg-indigo-900",
    row: "bg-indigo-500/10 ring-1 ring-indigo-500/50 ring-inset",
    soft: "bg-indigo-500/[0.06] dark:bg-indigo-400/[0.08]",
    icon: "text-indigo-600 dark:text-indigo-400",
  },
  reset: {
    line: "bg-emerald-500 dark:bg-emerald-400",
    flag: "border-emerald-500/40 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-400/40 dark:bg-emerald-950 dark:text-emerald-100 dark:hover:bg-emerald-900",
    edgeLeft: "border-l-emerald-500 dark:border-l-emerald-400",
    edgeRight: "border-r-emerald-500 dark:border-r-emerald-400",
    active: "bg-emerald-100 ring-2 ring-emerald-500/30 dark:bg-emerald-900",
    row: "bg-emerald-500/10 ring-1 ring-emerald-500/50 ring-inset",
    soft: "bg-emerald-500/[0.06] dark:bg-emerald-400/[0.07]",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
};

function describeState(label: LabelState): string {
  return `${TRUST_TONE[label.trust].label}, ${AUDIENCE_TONE[label.audience].label}`;
}

function describeChanges(
  labels: LabelSegment[],
  spans: TimelineSpan[],
): LabelChange[] {
  const out: LabelChange[] = [];
  for (let index = 1; index < labels.length; index++) {
    const seg = labels[index];
    const prev = labels[index - 1];
    const reset =
      seg.cause?.kind === "reset" ||
      (prev.trust === "suspicious" && seg.trust === "trusted");
    const parts: string[] = [];
    if (reset) parts.push(`Reset → ${describeState(seg)}`);
    else {
      if (seg.trust !== prev.trust)
        parts.push(`Trust → ${TRUST_TONE[seg.trust].label}`);
      if (seg.audience !== prev.audience)
        parts.push(`Audience → ${AUDIENCE_TONE[seg.audience].label}`);
    }
    if (parts.length === 0) continue;
    const firstRowKey = spans.find((s) => s.start >= seg.start)?.key ?? null;
    out.push({
      index,
      seg,
      text: parts.join(" · "),
      tone: reset ? "reset" : seg.trust !== prev.trust ? "trust" : "audience",
      firstRowKey,
      targetKey: seg.cause?.toolCallKey ?? firstRowKey,
    });
  }
  return out;
}

/**
 * Flags hang right of their switch (left when they would run off the end),
 * stepping down a level when they would cover the one before.
 */
function layoutFlags(changes: LabelChange[], width: number): PlacedFlag[] {
  const ends = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  return changes.map((change) => {
    const w = change.text.length * 6.3 + 32;
    const at = change.seg.x * width;
    const flip = at + w > width;
    const left = flip ? at - w : at;
    let level = ends.findIndex((end) => left >= end + 6);
    if (level === -1) level = ends[0] <= ends[1] ? 0 : 1;
    ends[level] = left + w;
    return { ...change, level, flip };
  });
}

function gutterTone(label: LabelState): { bar: string; text: string } {
  if (label.trust === "suspicious")
    return { bar: "bg-rose-500/80 dark:bg-rose-400/80", text: "Suspicious" };
  if (label.audience !== "public")
    return {
      bar: "bg-indigo-500/70 dark:bg-indigo-400/70",
      text: AUDIENCE_TONE[label.audience].label,
    };
  return { bar: "bg-emerald-500/25 dark:bg-emerald-400/25", text: "Trusted" };
}

/** Faint shading while the label is suspicious or its audience narrowed. */
function LabelZones({ labels }: { labels: LabelSegment[] }) {
  return (
    <>
      {labels.map((seg) => (
        <span key={`zone-${seg.start}`}>
          {seg.audience !== "public" ? (
            <span
              className="absolute inset-y-0 bg-indigo-500/[0.06] dark:bg-indigo-400/[0.08]"
              style={{ left: `${seg.x * 100}%`, width: `${seg.w * 100}%` }}
            />
          ) : null}
          {seg.trust === "suspicious" ? (
            <span
              className="absolute inset-y-0 bg-rose-500/[0.07] dark:bg-rose-400/[0.08]"
              style={{ left: `${seg.x * 100}%`, width: `${seg.w * 100}%` }}
            />
          ) : null}
        </span>
      ))}
    </>
  );
}

function ChangeFlag({
  flag,
  active,
  onHover,
  onJump,
}: {
  flag: PlacedFlag;
  active: boolean;
  onHover: (index: number | null) => void;
  onJump: () => void;
}) {
  const tone = CHANGE_TONE[flag.tone];
  const cause = flag.seg.cause;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-0 -translate-x-1/2",
          tone.line,
          active ? "w-[3px]" : "w-px opacity-70",
        )}
        style={{ left: `${flag.seg.x * 100}%` }}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onJump}
            onMouseEnter={() => onHover(flag.index)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(flag.index)}
            onBlur={() => onHover(null)}
            aria-label={`${flag.text}${cause?.toolName ? `, caused by ${cause.toolName}` : ""}. Jump to it.`}
            className={cn(
              "absolute z-[1] inline-flex h-5 cursor-pointer items-center gap-1 border px-1.5 text-[11px] leading-none font-medium whitespace-nowrap shadow-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60",
              tone.flag,
              flag.flip
                ? cn(
                    "-translate-x-full rounded-l-[4px] border-r-2",
                    tone.edgeRight,
                  )
                : cn("rounded-r-[4px] border-l-2", tone.edgeLeft),
              active && tone.active,
            )}
            style={{ left: `${flag.seg.x * 100}%`, top: 4 + flag.level * 24 }}
          >
            <Flag className="size-3 shrink-0" aria-hidden="true" />
            {flag.text}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-72">
          <p className="font-medium">{flag.text}</p>
          {cause ? <p className="opacity-80">{cause.summary}</p> : null}
          <p className="mt-1 opacity-70">
            {cause?.toolName && cause.toolCallKey
              ? `Click to select ${cause.toolName}`
              : "Click to jump here"}
          </p>
        </TooltipContent>
      </Tooltip>
    </>
  );
}

/** Phones: the switch as its own row in the list, in words. */
function PhoneChangeRow({
  change,
  onHover,
  onJump,
}: {
  change: LabelChange;
  onHover: (index: number | null) => void;
  onJump: () => void;
}) {
  const tone = CHANGE_TONE[change.tone];
  const gutter = gutterTone(change.seg);
  const cause = change.seg.cause;
  return (
    <li className="lg:hidden">
      <button
        type="button"
        onClick={onJump}
        onFocus={() => onHover(change.index)}
        onBlur={() => onHover(null)}
        className={cn(
          "relative flex h-9 w-full cursor-pointer items-center gap-2 border-b border-border/60 pr-4 pl-4 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset active:opacity-80",
          tone.soft,
        )}
      >
        <span
          aria-hidden="true"
          className={cn("absolute inset-y-0 left-0 w-1.5", gutter.bar)}
        />
        <Flag
          className={cn("size-3.5 shrink-0", tone.icon)}
          aria-hidden="true"
        />
        <span className="shrink-0 font-semibold">{change.text}</span>
        {cause?.toolName ? (
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            after <span className="font-mono">{cause.toolName}</span>
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ShieldOverlay({
  span,
  grid,
  layout,
  before,
  after,
  rowSelected,
  selectedConsultKey,
  onSelectConsult,
}: {
  span: TimelineSpan;
  grid: string;
  layout: Layout;
  before: MockConsult[];
  after: MockConsult[];
  rowSelected: boolean;
  selectedConsultKey: string | null;
  onSelectConsult?: (key: string | null) => void;
}) {
  const all = [...before, ...after];
  const primary =
    all.find((c) => c.decision === "blocked") ??
    all.find((c) => c.outcome !== "answered") ??
    all[0];
  const shieldProps = (consult: MockConsult) => ({
    consult,
    selected: consult.key === selectedConsultKey,
    tabbable: rowSelected,
    onOpen: () => onSelectConsult?.(consult.key),
  });
  // Closest to the bar first.
  const nearFirst = [...before].reverse();
  return (
    <div className={cn("pointer-events-none absolute inset-0 grid", grid)}>
      <span />
      <span className="relative mx-2 lg:mx-3">
        <span className="absolute inset-0 hidden lg:block">
          {all.map((c) => (
            <span
              key={`wait-${c.key}`}
              aria-hidden="true"
              className={cn(
                "absolute top-[calc(50%+7px)] h-0.5 rounded-full",
                c.decision === "blocked"
                  ? "bg-rose-500/60"
                  : "bg-muted-foreground/35",
              )}
              style={{
                left: `${c.x * 100}%`,
                width: `max(2px, ${c.w * 100}%)`,
              }}
            />
          ))}
          {nearFirst.map((c, i) => (
            <ConsultShield
              key={c.key}
              {...shieldProps(c)}
              style={{
                right: `calc(${(1 - span.x) * 100}% + ${2 + i * SHIELD_PX}px)`,
              }}
            />
          ))}
          {after.map((c, i) => (
            <ConsultShield
              key={c.key}
              {...shieldProps(c)}
              style={{
                left: `calc(${span.x * 100}% + max(5px, ${span.w * 100}%) + ${2 + i * SHIELD_PX}px)`,
              }}
            />
          ))}
        </span>
        {primary ? (
          <span className="absolute inset-y-0 right-0 flex items-center lg:hidden">
            <ConsultShield
              {...shieldProps(primary)}
              selected={all.some((c) => c.key === selectedConsultKey)}
              count={all.length}
            />
          </span>
        ) : null}
      </span>
      {layout === "trace" ? <span className="hidden lg:block" /> : null}
      <span />
    </div>
  );
}

function ConsultShield({
  consult,
  selected,
  tabbable,
  onOpen,
  count,
  style,
}: {
  consult: MockConsult;
  selected: boolean;
  tabbable: boolean;
  onOpen: () => void;
  count?: number;
  style?: CSSProperties;
}) {
  const neutral =
    consult.decision !== "blocked" && consult.outcome === "answered";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={tabbable ? 0 : -1}
          aria-pressed={selected}
          aria-label={`Guardrail check ${consult.externalName}: ${DECISION_TONE[consult.decision].label}. Open details.`}
          onClick={(event) => {
            event.stopPropagation();
            onOpen();
          }}
          className={cn(
            "pointer-events-auto inline-flex h-[22px] min-w-[22px] cursor-pointer items-center justify-center gap-0.5 rounded-md border px-0.5 text-[10px] font-medium tabular-nums outline-none transition-[background-color,border-color,box-shadow] duration-100 focus-visible:ring-2 focus-visible:ring-ring/60",
            style && "absolute top-1/2 -translate-y-1/2",
            selected
              ? "border-primary bg-primary/15 text-primary shadow-sm ring-2 ring-primary/30"
              : "border-transparent bg-card/85 hover:border-border hover:bg-muted hover:shadow-sm",
          )}
          style={style}
        >
          <DecisionIcon
            consult={consult}
            className={cn(
              neutral && "text-foreground/70",
              selected && neutral && "text-primary",
            )}
          />
          {count && count > 1 ? <span>{count}</span> : null}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72">
        <p className="flex items-center gap-1.5 font-medium">
          <span className="font-mono">{consult.externalName}</span>
          <span className="opacity-70">· {ROLE_LABEL[consult.role]}</span>
        </p>
        <p className="opacity-90">
          {DECISION_TONE[consult.decision].label}: {consult.answer}
        </p>
        <p className="opacity-70">
          {consult.beforeCall ? "Before the call" : "On the result"} ·{" "}
          {formatLatency(consult.durationMs)}
          {consult.outcome !== "answered" ? ` · ${consult.outcome}` : ""}
        </p>
        <p className="mt-1 opacity-70">
          {count && count > 1
            ? `${count} checks · click to open this one`
            : "Click to open details below"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function GuardrailsLegend({ className }: { className?: string }) {
  return (
    <ul
      aria-label="Guardrails key"
      className={cn(
        "min-w-0 items-center gap-x-4 overflow-hidden text-xs whitespace-nowrap text-muted-foreground",
        className,
      )}
    >
      <li className="inline-flex items-center gap-1.5">
        <ShieldCheck
          className="size-3.5 text-foreground/70"
          aria-hidden="true"
        />
        <span>Guardrail check</span>
        <span className="text-muted-foreground/70">(click to open)</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-3 rounded-[2px] bg-rose-500/20 ring-1 ring-rose-500/60 ring-inset"
        />
        <span>Suspicious</span>
      </li>
      <li className="inline-flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-2.5 w-3 rounded-[2px] bg-indigo-500/20 ring-1 ring-indigo-500/60 ring-inset"
        />
        <span>Audience narrowed</span>
      </li>
    </ul>
  );
}
