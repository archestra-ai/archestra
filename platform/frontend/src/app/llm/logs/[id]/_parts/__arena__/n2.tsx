"use client";
// design-arena: do not commit

import {
  ArrowRight,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Eye,
  EyeOff,
  Lock,
  MessageSquareText,
  RotateCcw,
  Send,
  Shield,
  ShieldAlert,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
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
  type Audience,
  CONSULT_KIND,
  DECISION_TONE,
  type GuardrailsData,
  type LabelSegment,
  type LabelState,
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
  const [checksShown, setChecksShown] = useState(true);

  // Every row the list draws, in order: requests and tool calls, each tool
  // call's checks just above (gates) and below (result checks) it, and a
  // divider wherever the session's label changed.
  const entries = useMemo(
    () => buildEntries({ spans, guardrails, checksShown }),
    [spans, guardrails, checksShown],
  );
  const steppable = useMemo(
    () =>
      entries.filter(
        (entry): entry is Exclude<Entry, { type: "change" }> =>
          entry.type !== "change",
      ),
    [entries],
  );
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
  const changesOnPage = entries.filter(
    (entry): entry is ChangeEntry => entry.type === "change",
  );
  const focusKey = consultRowSelected ? selectedConsultKey : selectedKey;
  const listRef = useRef<HTMLOListElement>(null);
  const changeRefs = useRef(new Map<string, HTMLLIElement>());
  // A change picked in the bar: its row is scrolled into view (after the
  // selection's own scroll) and ringed while what it points at is selected.
  const [jumpedChange, setJumpedChange] = useState<{
    key: string;
    nonce: number;
  } | null>(null);
  const activeChangeKey = (() => {
    const change = changesOnPage.find((c) => c.key === jumpedChange?.key);
    if (!change) return null;
    const cause = change.segment.cause;
    const target = cause?.consultKey ?? cause?.toolCallKey ?? null;
    return !target || target === focusKey ? change.key : null;
  })();
  const jumpToChange = (change: ChangeEntry) => {
    const cause = change.segment.cause;
    if (cause?.consultKey && checksShown && onSelectConsult) {
      onSelectConsult(cause.consultKey);
    } else if (
      cause?.toolCallKey &&
      spans.some((span) => span.key === cause.toolCallKey)
    ) {
      onSelect(cause.toolCallKey);
    }
    setJumpedChange({ key: change.key, nonce: Date.now() });
  };
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

  useEffect(() => {
    if (!jumpedChange) return;
    const scroller = scrollerRef.current;
    const row = changeRefs.current.get(jumpedChange.key);
    if (scroller && row) scrollWithin(scroller, row);
  }, [jumpedChange]);

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
    if (event.key === "Enter" && selected && !consultRowSelected) {
      event.preventDefault();
      onOpen(selected);
      return;
    }
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
      {guardrails ? (
        <GuardrailsBar
          consults={consultsOnPage}
          changes={changesOnPage}
          activeChangeKey={activeChangeKey}
          onJumpToChange={jumpToChange}
          checksShown={checksShown}
          onToggleChecks={() => setChecksShown((shown) => !shown)}
        />
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
                ref={listRef}
                className="relative"
                onKeyDown={onKeyDown}
                aria-label="Requests"
              >
                {entries.map((entry) => {
                  if (entry.type === "change") {
                    return (
                      <LabelChangeRow
                        key={entry.key}
                        rowRef={(el) => {
                          if (el) changeRefs.current.set(entry.key, el);
                          else changeRefs.current.delete(entry.key);
                        }}
                        active={entry.key === activeChangeKey}
                        layout={layout}
                        segment={entry.segment}
                        previous={entry.previous}
                        onSelectToolCall={
                          entry.segment.cause?.toolCallKey &&
                          spans.some(
                            (span) =>
                              span.key === entry.segment.cause?.toolCallKey,
                          )
                            ? () => {
                                const key = entry.segment.cause?.toolCallKey;
                                if (!key) return;
                                onSelect(key);
                                rowRefs.current
                                  .get(key)
                                  ?.focus({ preventScroll: true });
                              }
                            : null
                        }
                        onSelectConsult={
                          entry.segment.cause?.consultKey && onSelectConsult
                            ? () => {
                                const key = entry.segment.cause?.consultKey;
                                if (key) onSelectConsult(key);
                              }
                            : null
                        }
                      />
                    );
                  }
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
                        gutter={entry.gutter}
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
                    gutter: entry.gutter,
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
                      hiddenChecks={checksShown ? [] : entry.checks}
                      {...rowProps}
                    />
                  );
                })}
              </ol>
              {guardrails ? (
                <GutterRail listRef={listRef} entries={entries} />
              ) : null}
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
  selected: boolean;
  /** Its check is the selection: the row reads as that check's parent. */
  ancestor?: boolean;
  /** The label in force at the row's start, for the gutter. */
  gutter?: LabelSegment | null;
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
  ancestor = false,
  gutter = null,
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
  return (
    <li className="relative" {...gutterData(gutter)}>
      <GutterHit segment={gutter} />
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
            ? gutter
              ? GUTTER_SELECTED
              : "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]"
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
  hiddenChecks = [],
  ...rowProps
}: RowProps & {
  span: ToolCallSpan;
  display: McpServerDisplay | undefined;
  /** Its checks while the toolbar hides them: summarised in the name. */
  hiddenChecks?: MockConsult[];
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
          {hiddenChecks.length > 0 ? (
            <HiddenChecksBadge checks={hiddenChecks} />
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
// Guardrails (arena)
// ============================================================================

type Entry =
  | {
      type: "span";
      key: string;
      span: TimelineSpan;
      gutter: LabelSegment | null;
      /** The tool call's checks, for the badge while they are hidden. */
      checks: MockConsult[];
    }
  | {
      type: "consult";
      key: string;
      consult: MockConsult;
      toolSpan: TimelineSpan | null;
      gutter: LabelSegment | null;
    }
  | {
      type: "change";
      key: string;
      segment: LabelSegment;
      previous: LabelState;
    };

type ChangeEntry = Extract<Entry, { type: "change" }>;

function buildEntries({
  spans,
  guardrails,
  checksShown,
}: {
  spans: TimelineSpan[];
  guardrails: GuardrailsData | null;
  checksShown: boolean;
}): Entry[] {
  if (!guardrails || spans.length === 0) {
    return spans.map((span) => ({
      type: "span",
      key: span.key,
      span,
      gutter: null,
      checks: [],
    }));
  }
  const labelAt = (ms: number) => segmentAt(guardrails.labels, ms);
  const spanByKey = new Map(spans.map((span) => [span.key, span]));
  const pageStart = Math.min(...spans.map((span) => span.start));
  const pageEnd = Math.max(...spans.map((span) => span.end));

  const byTool = new Map<
    string,
    { before: MockConsult[]; after: MockConsult[] }
  >();
  const loose: MockConsult[] = [];
  for (const consult of guardrails.consults) {
    if (consult.toolCallKey && spanByKey.has(consult.toolCallKey)) {
      const bucket = byTool.get(consult.toolCallKey) ?? {
        before: [],
        after: [],
      };
      (consult.beforeCall ? bucket.before : bucket.after).push(consult);
      byTool.set(consult.toolCallKey, bucket);
    } else if (
      !consult.toolCallKey &&
      consult.start >= pageStart &&
      consult.start <= pageEnd
    ) {
      loose.push(consult);
    }
  }

  // A change its tool call caused sits right under that call (and its result
  // checks); any other change sits where it happened in time.
  const changesAfter = new Map<string, Entry[]>();
  const timed: { at: number; entry: Entry }[] = [];
  guardrails.labels.forEach((segment, index) => {
    if (index === 0 || !segment.cause) return;
    const previous = guardrails.labels[index - 1];
    const entry: Entry = {
      type: "change",
      key: `label-change-${segment.start}`,
      segment,
      previous: { trust: previous.trust, audience: previous.audience },
    };
    const toolKey = segment.cause.toolCallKey;
    if (toolKey && spanByKey.has(toolKey)) {
      changesAfter.set(toolKey, [...(changesAfter.get(toolKey) ?? []), entry]);
    } else if (segment.start >= pageStart && segment.start <= pageEnd) {
      timed.push({ at: segment.start, entry });
    }
  });
  for (const consult of loose) {
    timed.push({
      at: consult.start,
      entry: consultEntry(consult, null, labelAt),
    });
  }
  timed.sort((a, b) => a.at - b.at);

  const out: Entry[] = [];
  let next = 0;
  for (const span of spans) {
    while (next < timed.length && timed[next].at <= span.start) {
      const { entry } = timed[next++];
      if (entry.type !== "consult" || checksShown) out.push(entry);
    }
    const bucket = byTool.get(span.key);
    if (checksShown && bucket) {
      for (const c of bucket.before) out.push(consultEntry(c, span, labelAt));
    }
    out.push({
      type: "span",
      key: span.key,
      span,
      gutter: segmentAt(guardrails.labels, span.start),
      checks: bucket ? [...bucket.before, ...bucket.after] : [],
    });
    if (checksShown && bucket) {
      for (const c of bucket.after) out.push(consultEntry(c, span, labelAt));
    }
    out.push(...(changesAfter.get(span.key) ?? []));
  }
  for (; next < timed.length; next++) {
    const { entry } = timed[next];
    if (entry.type !== "consult" || checksShown) out.push(entry);
  }
  return out;
}

function consultEntry(
  consult: MockConsult,
  toolSpan: TimelineSpan | null,
  labelAt: (ms: number) => LabelSegment,
): Entry {
  return {
    type: "consult",
    key: consult.key,
    consult,
    toolSpan,
    gutter: labelAt(consult.start),
  };
}

function pageConsults({
  spans,
  guardrails,
}: {
  spans: TimelineSpan[];
  guardrails: GuardrailsData;
}): MockConsult[] {
  const keys = new Set(spans.map((span) => span.key));
  const pageStart = Math.min(...spans.map((span) => span.start));
  const pageEnd = Math.max(...spans.map((span) => span.end));
  return guardrails.consults.filter((c) =>
    c.toolCallKey
      ? keys.has(c.toolCallKey)
      : c.start >= pageStart && c.start <= pageEnd,
  );
}

/** "Blocked", or what went wrong when there was no answer. */
function decisionWord(consult: MockConsult): { text: string; tone: string } {
  if (consult.outcome === "timeout") {
    return { text: "Timed out", tone: "text-amber-700 dark:text-amber-300" };
  }
  if (consult.outcome === "non_success") {
    return { text: "Failed", tone: "text-amber-700 dark:text-amber-300" };
  }
  const tone = DECISION_TONE[consult.decision];
  return { text: tone.label, tone: tone.text };
}

function checkedWhat(consult: MockConsult): string {
  const tool = consult.toolName ?? "a tool call";
  return consult.beforeCall
    ? `checked before ${tool}`
    : `checked result of ${tool}`;
}

function segmentAt(labels: LabelSegment[], ms: number): LabelSegment {
  let hit = labels[0];
  for (const segment of labels) {
    if (segment.start <= ms) hit = segment;
    else break;
  }
  return hit;
}

/**
 * The strip under the header, on one line where it fits: the page's check
 * count, the Checks toggle, the gutter's key, and every label change as a
 * jump pill (folded into a "3 changes" menu when they do not fit). Phones
 * give the key its own second line.
 */
function GuardrailsBar({
  consults,
  changes,
  activeChangeKey,
  onJumpToChange,
  checksShown,
  onToggleChecks,
}: {
  consults: MockConsult[];
  changes: ChangeEntry[];
  activeChangeKey: string | null;
  onJumpToChange: (change: ChangeEntry) => void;
  checksShown: boolean;
  onToggleChecks: () => void;
}) {
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const unanswered = consults.filter((c) => c.outcome !== "answered").length;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b bg-muted/20 px-4 py-1.5 text-[11px] text-muted-foreground">
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap tabular-nums">
        <Shield className="size-3.5 text-foreground/70" aria-hidden="true" />
        <span>
          <span className="font-medium text-foreground">{consults.length}</span>{" "}
          {consults.length === 1 ? "check" : "checks"}
        </span>
        {blocked > 0 ? (
          <span className="text-rose-700 dark:text-rose-300">
            · {blocked} blocked
          </span>
        ) : null}
        {unanswered > 0 ? (
          <span className="text-amber-700 max-sm:hidden dark:text-amber-300">
            · {unanswered} unanswered
          </span>
        ) : null}
      </span>
      <UnstyledButton
        aria-pressed={checksShown}
        aria-label={checksShown ? "Hide checks" : "Show checks"}
        title={checksShown ? "Hide check rows" : "Show check rows"}
        onClick={onToggleChecks}
        className={cn(
          "-my-0.5 inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border px-1.5 font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/60 sm:h-6",
          checksShown
            ? "bg-card text-foreground/85 hover:bg-muted"
            : "border-dashed bg-transparent text-muted-foreground hover:bg-muted/60",
        )}
      >
        {checksShown ? (
          <Eye className="size-3.5" aria-hidden="true" />
        ) : (
          <EyeOff className="size-3.5" aria-hidden="true" />
        )}
        <span className="max-sm:hidden">Checks</span>
      </UnstyledButton>
      <GutterKey />
      <ChangeStrip
        changes={changes}
        activeKey={activeChangeKey}
        onJump={onJumpToChange}
      />
    </div>
  );
}

/** "Trust ▮▮ · Audience ┆ narrowed": what the rows' left edge means. */
function GutterKey() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="note"
          aria-label="Left edge of each row: the session label. Green is trusted, red is suspicious; a dashed line runs while the audience is narrower than public."
          className="inline-flex shrink-0 cursor-help items-center gap-1.5 whitespace-nowrap max-sm:order-last max-sm:basis-full"
        >
          <span>Trust</span>
          <span className="inline-flex items-center gap-0.5" aria-hidden="true">
            <span
              className={cn("h-3 w-1.5 rounded-[1px]", GUTTER_TRUST.trusted)}
            />
            <span
              className={cn("h-3 w-1.5 rounded-[1px]", GUTTER_TRUST.suspicious)}
            />
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span>Audience</span>
          <span aria-hidden="true" className={cn("h-3 w-0.5", RAIL_DASH)} />
          <span>narrowed</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64">
        <p className="font-medium">The rows' left edge is the session label</p>
        <p className="opacity-80">
          Green: trusted. Red: suspicious. A dashed line runs beside it while
          the audience is narrower than public (internal, a team, self). Hover
          the edge of any row for its label.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The page's label changes as pills, right-aligned in whatever room the bar
 * has left; when they would not fit, one "3 changes" button lists them.
 */
function ChangeStrip({
  changes,
  activeKey,
  onJump,
}: {
  changes: ChangeEntry[];
  activeKey: string | null;
  onJump: (change: ChangeEntry) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [fits, setFits] = useState(true);
  const [open, setOpen] = useState(false);
  const signature = changes.map((c) => c.key).join("|");

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the pills change
  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const check = () => setFits(measure.offsetWidth <= box.clientWidth);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(box);
    return () => observer.disconnect();
  }, [signature]);

  if (changes.length === 0) return <span className="flex-1" />;
  const described = changes.map((change) => ({
    change,
    ...describeChange(change.previous, change.segment),
  }));

  return (
    <div
      ref={boxRef}
      className="relative flex h-7 min-w-0 flex-1 items-center justify-end sm:h-6"
    >
      {/* The pills at their natural width, to decide whether they fit. */}
      <div
        ref={measureRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute top-0 right-0 flex w-max items-center gap-1"
      >
        {described.map(({ change, parts, tone }) => (
          <span key={change.key} className={cn(PILL_BASE, tone)}>
            <ChangeText kind={change.segment.cause?.kind} parts={parts} />
          </span>
        ))}
      </div>
      {fits ? (
        <ul
          aria-label="Label changes on this page"
          className="flex items-center gap-1"
        >
          {described.map(({ change, parts, tone }) => (
            <li key={change.key}>
              <UnstyledButton
                onClick={() => onJump(change)}
                title={`${change.segment.cause?.summary ?? "Label changed"}. Click to jump to it.`}
                className={cn(
                  PILL_BASE,
                  tone,
                  change.key === activeKey && "ring-2 ring-primary",
                )}
              >
                <ChangeText kind={change.segment.cause?.kind} parts={parts} />
              </UnstyledButton>
            </li>
          ))}
        </ul>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <UnstyledButton
              aria-label={`${changes.length} label ${changes.length === 1 ? "change" : "changes"} on this page`}
              className="inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-md border bg-card px-1.5 font-medium whitespace-nowrap text-foreground/85 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 data-[state=open]:bg-muted sm:h-6"
            >
              <span className="flex -space-x-0.5" aria-hidden="true">
                {described.slice(0, 3).map(({ change, dot }) => (
                  <span
                    key={change.key}
                    className={cn("size-2 rounded-full ring-1 ring-card", dot)}
                  />
                ))}
              </span>
              <span className="tabular-nums">
                {changes.length} {changes.length === 1 ? "change" : "changes"}
              </span>
              <ChevronDown className="size-3 opacity-70" aria-hidden="true" />
            </UnstyledButton>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-1">
            <p className="px-2 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
              Label changes on this page
            </p>
            <ul className="space-y-0.5">
              {described.map(({ change, parts, tone }) => (
                <li key={change.key}>
                  <UnstyledButton
                    onClick={() => {
                      setOpen(false);
                      onJump(change);
                    }}
                    className={cn(
                      "flex w-full cursor-pointer flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:bg-muted",
                      change.key === activeKey && "bg-primary/[0.07]",
                    )}
                  >
                    <span className="flex w-full items-center gap-2">
                      <span className={cn(PILL_BASE, tone)}>
                        <ChangeText
                          kind={change.segment.cause?.kind}
                          parts={parts}
                        />
                      </span>
                      <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
                        {formatDate({
                          date: new Date(change.segment.start).toISOString(),
                          dateFormat: "HH:mm:ss",
                        })}
                      </span>
                    </span>
                    <span className="text-[11px] leading-4 text-muted-foreground">
                      {change.segment.cause?.summary}
                    </span>
                  </UnstyledButton>
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}

type ChangePart = { field: string; to: string };

function ChangeText({
  kind,
  parts,
}: {
  kind: NonNullable<LabelSegment["cause"]>["kind"] | undefined;
  parts: ChangePart[];
}) {
  const Icon = kind ? CHANGE_ICON[kind] : ArrowRight;
  return (
    <>
      <Icon className="size-2.5 shrink-0" aria-hidden="true" />
      {parts.map((part, index) => (
        <span key={part.field} className="inline-flex items-center gap-0.5">
          {index > 0 ? <span className="opacity-50">·</span> : null}
          <span className="font-medium opacity-75">{part.field}</span>
          <span aria-hidden="true">→</span>
          <span>{part.to}</span>
        </span>
      ))}
    </>
  );
}

function describeChange(
  previous: LabelState,
  next: LabelSegment,
): { parts: ChangePart[]; tone: string; dot: string } {
  if (next.cause?.kind === "reset") {
    return {
      parts: [
        {
          field: "Reset",
          to: `${TRUST_TONE[next.trust].label} · ${AUDIENCE_TONE[next.audience].label}`,
        },
      ],
      tone: RESET_PILL,
      dot: "bg-muted-foreground/60",
    };
  }
  const parts: ChangePart[] = [];
  let tone = RESET_PILL;
  let dot = "bg-muted-foreground/60";
  if (previous.audience !== next.audience) {
    parts.push({ field: "Audience", to: AUDIENCE_TONE[next.audience].label });
    tone = AUDIENCE_PILL[next.audience];
    dot = AUDIENCE_TONE[next.audience].bar;
  }
  if (previous.trust !== next.trust) {
    parts.unshift({ field: "Trust", to: TRUST_TONE[next.trust].label });
    tone = TRUST_PILL[next.trust];
    dot = TRUST_TONE[next.trust].bar;
  }
  return { parts, tone, dot };
}

/** The data the gutter rail reads off each row to draw its runs. */
function gutterData(segment: LabelSegment | null | undefined) {
  if (!segment) return {};
  return {
    "data-gutter": `${segment.trust}|${segment.audience}`,
    "data-trust": segment.trust,
    "data-narrowed": segment.audience !== "public" ? "true" : "false",
  };
}

type GutterRun = {
  key: string;
  top: number;
  height: number;
  trust: Trust;
  narrowed: boolean;
};

/**
 * The label gutter, drawn once per run of rows under the same label rather
 * than once per row: a 6px trust bar and, while the audience is narrowed, a
 * dashed line beside it. One element per run keeps the dashes continuous
 * across row borders, check rows and dividers.
 */
function GutterRail({
  listRef,
  entries,
}: {
  listRef: RefObject<HTMLOListElement | null>;
  entries: Entry[];
}) {
  const [runs, setRuns] = useState<GutterRun[]>([]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the rows change
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      const next: GutterRun[] = [];
      for (const child of Array.from(list.children)) {
        if (!(child instanceof HTMLElement)) continue;
        const key = child.dataset.gutter;
        if (!key) continue;
        const top = child.offsetTop;
        const height = child.offsetHeight;
        const last = next[next.length - 1];
        if (
          last &&
          last.key === key &&
          Math.abs(last.top + last.height - top) < 1
        ) {
          last.height = top + height - last.top;
        } else {
          next.push({
            key,
            top,
            height,
            trust: child.dataset.trust as Trust,
            narrowed: child.dataset.narrowed === "true",
          });
        }
      }
      setRuns((prev) =>
        prev.length === next.length &&
        prev.every(
          (run, i) =>
            run.key === next[i].key &&
            run.top === next[i].top &&
            run.height === next[i].height,
        )
          ? prev
          : next,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [listRef, entries]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 left-0 z-[2] w-2.5"
    >
      {runs.map((run) => (
        <div
          key={`${run.top}-${run.key}`}
          className="absolute inset-x-0"
          style={{ top: run.top, height: run.height }}
        >
          <span
            className={cn(
              "absolute inset-y-0 left-0 w-1.5",
              GUTTER_TRUST[run.trust],
            )}
          />
          {run.narrowed ? (
            <span
              className={cn("absolute inset-y-0 left-2 w-0.5", RAIL_DASH)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}

/**
 * The gutter's 16px hover and tap target on a row: the label in words.
 * A tap toggles it, since touch has no hover.
 */
function GutterHit({ segment }: { segment: LabelSegment | null | undefined }) {
  const [open, setOpen] = useState(false);
  if (!segment) return null;
  const trust = TRUST_TONE[segment.trust];
  const audience = AUDIENCE_TONE[segment.audience];
  const since = formatDate({
    date: new Date(segment.start).toISOString(),
    dateFormat: "HH:mm:ss",
  });
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          onPointerDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen((shown) => !shown);
          }}
          className="absolute inset-y-0 left-0 z-[3] w-4 cursor-help"
        />
      </TooltipTrigger>
      <TooltipContent side="right" align="start" className="max-w-64">
        <p>
          <span className="text-muted-foreground">Label </span>
          <span className={cn("font-medium", trust.text)}>{trust.label}</span>
          <span className="text-muted-foreground"> · </span>
          <span className={cn("font-medium", audience.text)}>
            {audience.label}
          </span>
        </p>
        <p className="text-muted-foreground">
          {segment.audience === "public"
            ? "Audience: public"
            : `Audience narrowed to ${audience.label.toLowerCase()}`}
        </p>
        <p className="text-muted-foreground">
          {segment.cause
            ? `Since ${since}: ${segment.cause.summary}`
            : "Since the session started"}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** A tool call's checks while the toolbar hides them: the worst one's shield and a count. */
function HiddenChecksBadge({ checks }: { checks: MockConsult[] }) {
  const worst =
    checks.find((c) => c.decision === "blocked") ??
    checks.find((c) => c.outcome !== "answered") ??
    checks[0];
  return (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-muted px-1 text-[10px] leading-4 text-muted-foreground"
      title={`${checks.length} guardrail ${checks.length === 1 ? "check" : "checks"}; show checks to open them`}
    >
      <DecisionIcon consult={worst} className="size-3" />
      {checks.length}
    </span>
  );
}

/**
 * A guardrail check as its own compact row under (or, for a gate, above)
 * its tool call: shield, name, what it checked, and the decision word at the
 * end. The whole row opens it in the pane below.
 */
function ConsultRow({
  layout,
  consult,
  toolSpan,
  gutter,
  selected,
  buttonRef,
  onSelect,
}: {
  layout: Layout;
  consult: MockConsult;
  toolSpan: TimelineSpan | null;
  gutter: LabelSegment | null;
  selected: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const decision = decisionWord(consult);
  const duration = formatLatency(consult.durationMs);
  const what = checkedWhat(consult);
  const loud = consult.decision === "blocked" || consult.outcome !== "answered";
  // A dotted lead between the check and the call it guards.
  const lead = toolSpan
    ? consult.beforeCall
      ? { from: consult.x + consult.w, to: toolSpan.x }
      : { from: toolSpan.x + toolSpan.w, to: consult.x }
    : null;
  const tools = layout === "tools";
  return (
    <li className="relative" {...gutterData(gutter)}>
      <GutterHit segment={gutter} />
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        aria-label={`Guardrail check ${consult.externalName}, ${what}: ${decision.text}. Opens its details below.`}
        className={cn(
          "group grid h-9 w-full cursor-pointer scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-8",
          GRIDS[layout],
          selected ? GUTTER_SELECTED : "bg-muted/20 hover:bg-muted/60",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 pr-3 pl-[30px] lg:pl-[34px]">
          <span
            aria-hidden="true"
            className={cn(
              "w-px shrink-0 self-stretch bg-border",
              consult.beforeCall ? "mt-2" : "mb-2",
            )}
          />
          <DecisionIcon
            consult={consult}
            className={cn(
              "ml-1 size-3",
              !loud && !selected && "opacity-70",
              selected && !loud && "text-foreground",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span
              className={cn(
                "truncate font-mono text-[11.5px] leading-4",
                selected ? "font-medium text-foreground" : "text-foreground/85",
              )}
            >
              {consult.externalName}
            </span>
            <span
              className={cn(
                "truncate text-[10.5px] leading-[14px]",
                selected ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              {what}
              <span className="max-lg:hidden">
                {" "}
                · {ROLE_LABEL[consult.role]}
              </span>
              <span className="lg:hidden"> · {duration}</span>
            </span>
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground group-focus-visible:text-muted-foreground max-lg:hidden",
              selected && "text-primary/70",
            )}
          />
        </span>

        <span className="relative mx-2 block lg:mx-3">
          {lead && lead.to > lead.from ? (
            <span
              aria-hidden="true"
              className="absolute top-1/2 border-t border-dotted border-muted-foreground/40"
              style={{
                left: `${lead.from * 100}%`,
                width: `${(lead.to - lead.from) * 100}%`,
              }}
            />
          ) : null}
          <span
            aria-hidden="true"
            className={cn(
              "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
              CONSULT_KIND.bar,
              !loud && !selected && "opacity-60",
              selected && "ring-2 ring-offset-1 ring-offset-card",
              selected && CONSULT_KIND.ring,
            )}
            style={{
              left: `${consult.x * 100}%`,
              width: `max(4px, ${consult.w * 100}%)`,
            }}
          />
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[10.5px] whitespace-nowrap text-muted-foreground/80 tabular-nums lg:block"
            style={
              placeLatency(consult) === "after"
                ? { left: `calc(${(consult.x + consult.w) * 100}% + 8px)` }
                : { right: `calc(${(1 - consult.x) * 100}% + 6px)` }
            }
          >
            {duration}
          </span>
        </span>

        {tools ? null : <span className="hidden lg:block" />}

        <span
          className={cn(
            "flex items-center justify-end pr-4 text-[11px]",
            loud ? cn("font-semibold", decision.tone) : "font-medium",
            !loud && (selected ? decision.tone : "text-muted-foreground"),
          )}
        >
          {decision.text}
        </span>
      </UnstyledButton>
    </li>
  );
}

/**
 * Where the session's label changed: what changed, in words, and what caused
 * it. The row selects the tool call that caused it; "See check" opens the
 * check whose answer moved it.
 */
function LabelChangeRow({
  layout,
  segment,
  previous,
  active,
  rowRef,
  onSelectToolCall,
  onSelectConsult,
}: {
  layout: Layout;
  segment: LabelSegment;
  previous: LabelState;
  /** Picked from the bar's change pills. */
  active: boolean;
  rowRef: (el: HTMLLIElement | null) => void;
  onSelectToolCall: (() => void) | null;
  onSelectConsult: (() => void) | null;
}) {
  const changes: {
    dimension: "Trust" | "Audience";
    from: Trust | Audience;
    to: Trust | Audience;
  }[] = [];
  if (previous.trust !== segment.trust) {
    changes.push({
      dimension: "Trust",
      from: previous.trust,
      to: segment.trust,
    });
  }
  if (previous.audience !== segment.audience) {
    changes.push({
      dimension: "Audience",
      from: previous.audience,
      to: segment.audience,
    });
  }
  const cause = segment.cause;
  const causeText = cause?.toolName
    ? cause.kind === "reset"
      ? `reset by ${cause.toolName}`
      : `after ${cause.toolName}`
    : "reset";
  const markerTone = TRUST_TONE[segment.trust];
  const time = formatDate({
    date: new Date(segment.start).toISOString(),
    dateFormat: "HH:mm:ss",
  });
  const label = `Label changed: ${changes
    .map(
      (c) =>
        `${c.dimension} ${tone(c.dimension, c.from).label} to ${tone(c.dimension, c.to).label}`,
    )
    .join(", ")}. ${cause?.summary ?? ""}`;

  const body = (
    <>
      <span className="flex min-w-0 flex-col justify-center gap-0.5 py-1.5 pr-2 pl-4">
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {changes.map((change) => (
            <span
              key={change.dimension}
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] leading-5",
                change.dimension === "Trust"
                  ? TRUST_TONE[change.to as Trust].soft
                  : "bg-card",
              )}
            >
              <span className="font-medium text-foreground/80">
                {change.dimension}
              </span>
              <span className="text-muted-foreground max-sm:hidden">
                {tone(change.dimension, change.from).label}
              </span>
              <ArrowRight
                aria-hidden="true"
                className="size-3 text-muted-foreground max-sm:hidden"
              />
              <span
                className={cn(
                  "font-semibold",
                  tone(change.dimension, change.to).text,
                )}
              >
                {tone(change.dimension, change.to).label}
              </span>
            </span>
          ))}
        </span>
        <span className="truncate text-[10.5px] leading-[14px] text-muted-foreground lg:hidden">
          {causeText}
        </span>
      </span>
      <span className="relative mx-2 block lg:mx-3">
        <span
          aria-hidden="true"
          className={cn(
            "absolute inset-y-1 w-[2px] -translate-x-1/2 rounded-full",
            markerTone.bar,
          )}
          style={{ left: `${segment.x * 100}%` }}
        />
        <span
          className={cn(
            "absolute top-1/2 hidden max-w-[62%] -translate-y-1/2 truncate text-[11px] text-muted-foreground lg:block",
          )}
          style={
            segment.x < 0.55
              ? { left: `calc(${segment.x * 100}% + 8px)` }
              : { right: `calc(${(1 - segment.x) * 100}% + 8px)` }
          }
        >
          <span className="font-mono text-foreground/80">{causeText}</span>
          {cause ? ` · ${cause.summary}` : null}
        </span>
      </span>
    </>
  );

  return (
    <li
      ref={rowRef}
      {...gutterData(segment)}
      className={cn(
        "relative grid scroll-mt-8 border-y border-dashed border-border bg-card transition-colors",
        active && "bg-primary/[0.05] ring-1 ring-primary/45 ring-inset",
        GRIDS[layout],
      )}
    >
      <GutterHit segment={segment} />
      {onSelectToolCall ? (
        <UnstyledButton
          onClick={onSelectToolCall}
          aria-label={`${label} Selects ${cause?.toolName ?? "the tool call"}.`}
          className="col-span-2 grid min-h-9 cursor-pointer grid-cols-subgrid text-left text-xs outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
        >
          {body}
        </UnstyledButton>
      ) : (
        <div
          role="note"
          aria-label={label}
          className="col-span-2 grid min-h-9 grid-cols-subgrid text-xs"
        >
          {body}
        </div>
      )}
      <span
        className={cn(
          "flex items-center justify-end gap-2 pr-2 text-[11px] text-muted-foreground tabular-nums lg:pr-4",
          layout === "trace" && "lg:col-span-2",
        )}
      >
        <span className="max-lg:hidden">{time}</span>
        {onSelectConsult ? (
          <UnstyledButton
            onClick={onSelectConsult}
            aria-label="See the check that changed the label"
            className="-my-1 inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border bg-card px-1 font-medium lg:h-6 lg:px-1.5 text-foreground/85 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            <Shield className="size-3" aria-hidden="true" />
            <span>
              <span className="max-lg:hidden">See c</span>
              <span className="lg:hidden">C</span>heck
            </span>
          </UnstyledButton>
        ) : (
          <span className="lg:hidden">{time}</span>
        )}
      </span>
    </li>
  );
}

function tone(
  dimension: "Trust" | "Audience",
  value: Trust | Audience,
): { label: string; text: string } {
  return dimension === "Trust"
    ? TRUST_TONE[value as Trust]
    : AUDIENCE_TONE[value as Audience];
}

/** A selected row beside the gutter: tinted and outlined (the old inset bar would sit under the gutter). */
const GUTTER_SELECTED = "bg-primary/[0.08] ring-1 ring-primary/45 ring-inset";
/** 6px trust bar: quiet when trusted, loud when suspicious. */
const GUTTER_TRUST: Record<Trust, string> = {
  trusted: "bg-emerald-500/45 dark:bg-emerald-400/40",
  suspicious: "bg-rose-500 dark:bg-rose-400",
};
/** The narrowed-audience line: 4px dashes, anchored to its run's top. */
const RAIL_DASH =
  "[--rail:var(--color-indigo-500)] dark:[--rail:var(--color-indigo-300)] bg-[repeating-linear-gradient(to_bottom,var(--rail)_0_4px,transparent_4px_7px)]";
const PILL_BASE =
  "relative inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ring-1 ring-inset transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring";
const TRUST_PILL: Record<Trust, string> = {
  suspicious:
    "bg-rose-500/15 text-rose-700 ring-rose-500/40 hover:bg-rose-500/25 dark:text-rose-300",
  trusted:
    "bg-emerald-500/15 text-emerald-700 ring-emerald-500/40 hover:bg-emerald-500/25 dark:text-emerald-300",
};
const AUDIENCE_PILL: Record<Audience, string> = {
  public:
    "bg-sky-500/15 text-sky-700 ring-sky-500/40 hover:bg-sky-500/25 dark:text-sky-300",
  internal:
    "bg-indigo-500/15 text-indigo-700 ring-indigo-500/40 hover:bg-indigo-500/25 dark:text-indigo-300",
  "@payments":
    "bg-violet-500/15 text-violet-700 ring-violet-500/40 hover:bg-violet-500/25 dark:text-violet-300",
  self: "bg-fuchsia-500/15 text-fuchsia-700 ring-fuchsia-500/40 hover:bg-fuchsia-500/25 dark:text-fuchsia-300",
};
const RESET_PILL = "bg-muted text-foreground/80 ring-border hover:bg-muted/70";
const CHANGE_ICON: Record<
  NonNullable<LabelSegment["cause"]>["kind"],
  typeof ShieldAlert
> = {
  admitted: ShieldAlert,
  narrowed: Lock,
  released: Send,
  reset: RotateCcw,
};
