"use client";

import {
  ChevronLeft,
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
  ShieldX,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
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
import { DecisionIcon } from "./guardrails-arena";
// design-arena: do not commit
import {
  AUDIENCE_TONE,
  CONSULT_KIND,
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
  const [checksShown, setChecksShown] = useState(true);

  // Every row the list draws, in order: requests and tool calls, and each
  // tool call's checks just above (gates) and below (result checks) it.
  // Label changes add no rows: the gutter carries them.
  const entries = useMemo(
    () => buildEntries({ spans, guardrails, checksShown }),
    [spans, guardrails, checksShown],
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
  // A change selects what caused it: the check whose answer moved the label
  // (its details are the why), else the tool call, else the first row under
  // the new label.
  const activateChange = (change: LabelChange) => {
    if (change.target.type === "consult") onSelectConsult?.(change.target.key);
    else onSelect(change.target.key);
  };
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
          changes={changes}
          activeChange={changes.findIndex(isChangeActive)}
          onActivateChange={activateChange}
          label={labelHere}
          labelName={labelHereName}
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
  /** The label gutter at the row's left edge (and its change nodes). */
  gutter?: GutterProps | null;
  /** Label changes this row caused, noted on its detail line. */
  note?: LabelChange[] | null;
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
  note = null,
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
    <li className="relative">
      {gutter ? <LabelGutter {...gutter} onSelectRow={onSelect} /> : null}
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={`${label}${gutterWords(gutter, note)}`}
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
      gutter: LabelState | null;
      /** The tool call's checks, for the badge while they are hidden. */
      checks: MockConsult[];
    }
  | {
      type: "consult";
      key: string;
      consult: MockConsult;
      toolSpan: TimelineSpan | null;
      gutter: LabelState | null;
    };

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
  const { labelAt } = guardrails;
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

  const timed: { at: number; entry: Entry }[] = [];
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
      if (checksShown) out.push(entry);
    }
    const bucket = byTool.get(span.key);
    if (checksShown && bucket) {
      for (const c of bucket.before) out.push(consultEntry(c, span, labelAt));
    }
    out.push({
      type: "span",
      key: span.key,
      span,
      gutter: labelAt(span.start),
      checks: bucket ? [...bucket.before, ...bucket.after] : [],
    });
    if (checksShown && bucket) {
      for (const c of bucket.after) out.push(consultEntry(c, span, labelAt));
    }
  }
  for (; next < timed.length; next++) {
    const { entry } = timed[next];
    if (checksShown) out.push(entry);
  }
  return out;
}

function consultEntry(
  consult: MockConsult,
  toolSpan: TimelineSpan | null,
  labelAt: (ms: number) => LabelState,
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

/**
 * The one-line strip under the header: the page's checks, the check-rows
 * toggle, the gutter's key, and a stepper through the label changes (each a
 * dot in the gutter). Phones put the key on a second line.
 */
function GuardrailsBar({
  consults,
  changes,
  activeChange,
  onActivateChange,
  label,
  labelName,
  checksShown,
  onToggleChecks,
}: {
  consults: MockConsult[];
  changes: LabelChange[];
  /** Index of the change whose cause is selected, or -1. */
  activeChange: number;
  onActivateChange: (change: LabelChange) => void;
  label: LabelState | null;
  labelName: string;
  checksShown: boolean;
  onToggleChecks: () => void;
}) {
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const unanswered = consults.filter((c) => c.outcome !== "answered").length;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b bg-muted/20 px-4 py-1 text-[11px] text-muted-foreground">
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex h-7 cursor-default items-center gap-1.5 tabular-nums lg:h-6">
            <Shield
              className="size-3.5 text-foreground/70"
              aria-hidden="true"
            />
            <span>
              <span className="font-medium text-foreground/90">
                {consults.length}
              </span>{" "}
              {consults.length === 1 ? "check" : "checks"}
            </span>
            {blocked > 0 ? (
              <span className="inline-flex items-center gap-0.5 font-medium text-rose-700 dark:text-rose-300">
                <ShieldX className="size-3" aria-hidden="true" />
                {blocked}
                <span className="max-sm:sr-only"> blocked</span>
              </span>
            ) : null}
            {unanswered > 0 ? (
              <span className="inline-flex items-center gap-0.5 text-amber-700 dark:text-amber-300">
                <ShieldAlert className="size-3" aria-hidden="true" />
                {unanswered}
                <span className="max-sm:sr-only"> unanswered</span>
              </span>
            ) : null}
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          Guardrail checks on this page, each a row beside the tool call it
          guarded. Click one to open its details below.
        </TooltipContent>
      </Tooltip>
      <UnstyledButton
        aria-pressed={checksShown}
        aria-label={checksShown ? "Hide check rows" : "Show check rows"}
        title={checksShown ? "Hide check rows" : "Show check rows"}
        onClick={onToggleChecks}
        className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md border bg-card px-1.5 font-medium text-foreground/85 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 max-sm:w-7 max-sm:justify-center lg:h-6"
      >
        {checksShown ? (
          <Eye className="size-3.5" aria-hidden="true" />
        ) : (
          <EyeOff className="size-3.5" aria-hidden="true" />
        )}
        <span className="max-sm:hidden">Checks</span>
      </UnstyledButton>
      <GutterKey />
      {label ? (
        <span
          className="hidden min-w-0 items-center gap-1.5 xl:ml-auto xl:inline-flex"
          title={`Label at ${labelName}`}
        >
          <span>Here</span>
          <GutterSwatch label={label} />
          <span className={cn("font-medium", TRUST_TONE[label.trust].text)}>
            {TRUST_TONE[label.trust].label}
          </span>
          <span aria-hidden="true" className="text-muted-foreground/50">
            ·
          </span>
          <span
            className={cn("font-medium", AUDIENCE_TONE[label.audience].text)}
          >
            {AUDIENCE_TONE[label.audience].label}
          </span>
        </span>
      ) : null}
      {changes.length > 0 ? (
        <ChangeStepper
          changes={changes}
          active={activeChange}
          onActivate={onActivateChange}
        />
      ) : null}
    </div>
  );
}

/** "‹ 2/3 changes ›": steps through the label changes, selecting each cause. */
function ChangeStepper({
  changes,
  active,
  onActivate,
}: {
  changes: LabelChange[];
  active: number;
  onActivate: (change: LabelChange) => void;
}) {
  const step = (delta: number) => {
    const from = active < 0 ? (delta > 0 ? -1 : 0) : active;
    onActivate(changes[(from + delta + changes.length) % changes.length]);
  };
  const arrow =
    "flex w-7 shrink-0 cursor-pointer items-center justify-center outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset lg:w-6";
  return (
    <span className="ml-auto inline-flex h-7 shrink-0 items-stretch overflow-hidden rounded-md border bg-card text-foreground/85 xl:ml-0 lg:h-6">
      <UnstyledButton
        aria-label="Previous label change"
        onClick={() => step(-1)}
        className={arrow}
      >
        <ChevronLeft className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <UnstyledButton
            onClick={() => onActivate(changes[Math.max(0, active)])}
            aria-label={`${changes.length} label ${changes.length === 1 ? "change" : "changes"}${active >= 0 ? `, ${active + 1} selected: ${changeWords(changes[active])}` : ""}. Select its cause.`}
            className="inline-flex cursor-pointer items-center gap-1 border-x px-1.5 font-medium whitespace-nowrap tabular-nums outline-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                active >= 0 ? "bg-primary" : "bg-foreground/40",
              )}
            />
            <span>
              {active >= 0 ? (
                <>
                  {active + 1}
                  <span className="text-muted-foreground">
                    /{changes.length}
                  </span>
                </>
              ) : (
                changes.length
              )}{" "}
              <span className="max-lg:hidden">label </span>
              {changes.length === 1 ? "change" : "changes"}
            </span>
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" className="max-w-xs">
          <ol className="space-y-0.5">
            {changes.map((change, index) => (
              <li
                key={change.key}
                className={cn(index === active ? "font-medium" : "opacity-80")}
              >
                {index + 1}. {changeWords(change)}{" "}
                <span className="opacity-70">· {causeShort(change)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 opacity-70">
            Each is a dot in the left gutter. Step to select what caused it.
          </p>
        </TooltipContent>
      </Tooltip>
      <UnstyledButton
        aria-label="Next label change"
        onClick={() => step(1)}
        className={arrow}
      >
        <ChevronRight className="size-3.5" aria-hidden="true" />
      </UnstyledButton>
    </span>
  );
}

/** The gutter's key, in three words; the tooltip says the rest. */
function GutterKey() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <ul
          aria-label="Label gutter key: colour is trust, stripes mean the audience is narrowed"
          className="flex h-6 cursor-default items-center gap-x-2.5 whitespace-nowrap max-md:order-last max-md:basis-full"
        >
          <li className="inline-flex items-center gap-1">
            <GutterSwatch label={{ trust: "trusted", audience: "public" }} />
            Trusted
          </li>
          <li className="inline-flex items-center gap-1">
            <GutterSwatch label={{ trust: "suspicious", audience: "public" }} />
            Suspicious
          </li>
          <li className="inline-flex items-center gap-1">
            <GutterSwatch label={null} />
            Narrowed
          </li>
          <li className="hidden items-center gap-1 xl:inline-flex">
            <span
              aria-hidden="true"
              className="size-2 rounded-full bg-foreground/60 ring-2 ring-card"
            />
            Change
          </li>
        </ul>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-xs">
        The left gutter is the session label at each row. Its colour is trust;
        stripes mean the audience is narrower than public (internal, a team, or
        self). A dot marks where it changed: hover it for why.
      </TooltipContent>
    </Tooltip>
  );
}

function GutterSwatch({ label }: { label: LabelState | null }) {
  return (
    <span
      aria-hidden="true"
      className="relative h-3.5 w-2 shrink-0 overflow-hidden rounded-[2px] bg-card ring-1 ring-border/60"
    >
      <span
        className={cn(
          "absolute inset-0",
          label ? GUTTER_FILL[label.trust] : "bg-muted",
        )}
      />
      {!label || label.audience !== "public" ? <Stripes /> : null}
    </span>
  );
}

/**
 * Narrowed-audience stripes. One 8px tile anchored so every row's stripes
 * meet the next row's: lg rows are 40/32px (multiples of 8), phone rows
 * 44/36px, so every other phone row shifts the tile by half.
 */
function Stripes({ odd = false }: { odd?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "absolute inset-0 [--stripe:rgb(15_23_42/0.42)] dark:[--stripe:rgb(241_245_249/0.5)]",
        odd && "max-lg:[background-position:0_-4px]",
      )}
      style={STRIPE_STYLE}
    />
  );
}

type GutterProps = {
  label: LabelState;
  /** Odd rows shift the stripe tile on phones; see `Stripes`. */
  odd: boolean;
  /** Change dots on this row's top or bottom edge. */
  nodes: { top: LabelChange[]; bottom: LabelChange[] } | null;
  isChangeActive: (change: LabelChange) => boolean;
  onActivateChange: (change: LabelChange) => void;
};

/**
 * The row's 8px label gutter: filled by trust, striped when the audience is
 * narrowed, with a 16px hover/tap target for its tooltip and a dot on the
 * edge where the label changed.
 */
function LabelGutter({
  label,
  odd,
  nodes,
  isChangeActive,
  onActivateChange,
  onSelectRow,
}: GutterProps & { onSelectRow: () => void }) {
  const [open, setOpen] = useState(false);
  const narrowed = label.audience !== "public";
  return (
    <>
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 z-[1] w-2 bg-card"
      >
        <span className={cn("absolute inset-0", GUTTER_FILL[label.trust])} />
        {narrowed ? <Stripes odd={odd} /> : null}
      </span>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <span
            aria-hidden="true"
            // A tap selects the row and keeps the tooltip open: touch has no
            // hover, and the trigger would close it on click and on leave.
            onClick={(event: MouseEvent<HTMLSpanElement>) => {
              event.preventDefault();
              onSelectRow();
              setOpen(true);
            }}
            onPointerLeave={(event: PointerEvent<HTMLSpanElement>) => {
              if (event.pointerType === "touch") event.preventDefault();
            }}
            className="absolute inset-y-0 left-0 z-[2] w-4 cursor-pointer"
          />
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-xs">
          <p>
            <span className="font-medium">Label</span>{" "}
            {TRUST_TONE[label.trust].label} ·{" "}
            {AUDIENCE_TONE[label.audience].label}
          </p>
          <p className="opacity-70">
            {narrowed
              ? `Striped: audience narrowed to ${AUDIENCE_TONE[label.audience].label.toLowerCase()}`
              : "Plain: audience is public"}
          </p>
        </TooltipContent>
      </Tooltip>
      {nodes && nodes.top.length > 0 ? (
        <ChangeNode
          at="top"
          changes={nodes.top}
          active={nodes.top.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
      {nodes && nodes.bottom.length > 0 ? (
        <ChangeNode
          at="bottom"
          changes={nodes.bottom}
          active={nodes.bottom.some(isChangeActive)}
          onActivate={onActivateChange}
        />
      ) : null}
    </>
  );
}

/**
 * A label change: a dot on the gutter where the colour or stripes switch.
 * Solid in the new trust colour when trust moved (or the label reset),
 * hollow when only the audience did. Clicking selects the cause.
 */
function ChangeNode({
  at,
  changes,
  active,
  onActivate,
}: {
  at: "top" | "bottom";
  changes: LabelChange[];
  active: boolean;
  onActivate: (change: LabelChange) => void;
}) {
  const last = changes[changes.length - 1];
  const solid = changes.some((c) => c.trustChanged);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          tabIndex={-1}
          onClick={() => onActivate(last)}
          aria-label={`Label changed: ${changes.map(changeWords).join("; ")}. Select its cause.`}
          className={cn(
            "group/node absolute left-0 z-[4] flex size-4 cursor-pointer items-center outline-none",
            at === "top"
              ? "top-0 -translate-y-1/2"
              : "bottom-0 translate-y-1/2",
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-2.5 rounded-full ring-2 ring-card transition-transform group-hover/node:scale-125",
              solid
                ? TRUST_TONE[last.segment.trust].bar
                : "bg-card shadow-[inset_0_0_0_2px_var(--color-foreground)] opacity-90",
              active && "outline-2 outline-offset-1 outline-primary",
            )}
          />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        {changes.map((change) => (
          <div key={change.key}>
            <p className="font-medium">{changeWords(change)}</p>
            <p className="opacity-80">{change.cause.summary}</p>
          </div>
        ))}
        <p className="mt-0.5 opacity-70">Click to select its cause</p>
      </TooltipContent>
    </Tooltip>
  );
}

/** "· 🔒 Audience → Internal" on the cause row's detail line. */
function ChangeNote({ changes }: { changes: LabelChange[] }) {
  return (
    <span className="inline-flex min-w-0 shrink items-center gap-1 overflow-hidden whitespace-nowrap">
      <span aria-hidden="true" className="shrink-0 text-muted-foreground/40">
        ·
      </span>
      {changes.map((change) => {
        const Icon = CHANGE_ICON[change.cause.kind];
        return (
          <span
            key={change.key}
            className="inline-flex shrink-0 items-center gap-1 text-muted-foreground"
          >
            <Icon className="size-3 shrink-0 opacity-80" aria-hidden="true" />
            {change.parts.map((part, index) => (
              <span key={part.field} className="inline-flex items-center gap-1">
                {index > 0 ? <span className="opacity-50">,</span> : null}
                {/* Phones keep the new value; the icon says which kind. */}
                <span className="max-lg:hidden">{part.field}</span>
                <span aria-hidden="true" className="opacity-60">
                  →
                </span>
                <span className={cn("font-medium opacity-90", part.tone)}>
                  {part.to}
                </span>
              </span>
            ))}
          </span>
        );
      })}
    </span>
  );
}

/** The row's label in words, and what it changed, for its accessible name. */
function gutterWords(
  gutter: GutterProps | null,
  note: LabelChange[] | null,
): string {
  if (!gutter) return "";
  const here = `, label ${TRUST_TONE[gutter.label.trust].label} ${AUDIENCE_TONE[gutter.label.audience].label}`;
  return note && note.length > 0
    ? `${here}, changed the label: ${note.map(changeWords).join("; ")}`
    : here;
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
 * its tool call: the whole row opens it in the pane below.
 */
function ConsultRow({
  layout,
  consult,
  toolSpan,
  gutter,
  note,
  selected,
  buttonRef,
  onSelect,
}: {
  layout: Layout;
  consult: MockConsult;
  toolSpan: TimelineSpan | null;
  gutter: GutterProps | null;
  note: LabelChange[] | null;
  selected: boolean;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
}) {
  const decision = decisionWord(consult);
  const duration = formatLatency(consult.durationMs);
  const what = checkedWhat(consult);
  // A dotted lead between the check and the call it guards.
  const lead = toolSpan
    ? consult.beforeCall
      ? { from: consult.x + consult.w, to: toolSpan.x }
      : { from: toolSpan.x + toolSpan.w, to: consult.x }
    : null;
  const tools = layout === "tools";
  return (
    <li className="relative">
      {gutter ? <LabelGutter {...gutter} onSelectRow={onSelect} /> : null}
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        aria-label={`Guardrail check ${consult.externalName}, ${what}: ${decision.text}${gutterWords(gutter, note)}. Opens its details below.`}
        className={cn(
          "group grid h-9 w-full cursor-pointer scroll-mt-8 scroll-mb-1 border-b border-border/40 text-left text-xs outline-none transition-colors duration-100 lg:h-8",
          GRIDS[layout],
          selected
            ? cn(
                "bg-primary/[0.07]",
                gutter ? SELECTED_PAST_GUTTER : SELECTED_EDGE,
              )
            : "bg-muted/25 hover:bg-muted/70",
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
              "ml-1",
              selected && consult.decision !== "blocked" && "text-foreground",
            )}
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-1.5 leading-4">
              <span className="truncate font-mono text-[11.5px] font-medium">
                {consult.externalName}
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-sm px-1 text-[10px] leading-[14px] font-medium",
                  CONSULT_KIND.chip,
                )}
              >
                Check
              </span>
            </span>
            <span
              className={cn(
                "flex min-w-0 items-center gap-1 text-[10.5px] leading-[14px]",
                selected ? "text-foreground/70" : "text-muted-foreground",
              )}
            >
              <span className="min-w-0 truncate">
                {what}
                <span className="max-lg:hidden">
                  {" "}
                  · {ROLE_LABEL[consult.role]}
                </span>
                <span className="lg:hidden"> · {duration}</span>
              </span>
              {note && note.length > 0 ? <ChangeNote changes={note} /> : null}
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
              consult.decision !== "blocked" && "opacity-80",
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
            className="pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[10.5px] whitespace-nowrap text-muted-foreground tabular-nums lg:block"
            style={
              placeLatency(consult) === "after"
                ? { left: `calc(${(consult.x + consult.w) * 100}% + 8px)` }
                : { right: `calc(${(1 - consult.x) * 100}% + 6px)` }
            }
          >
            {duration}
          </span>
        </span>

        {tools ? null : (
          <span
            className={cn(
              WIDE_ONLY,
              "items-center justify-end px-3 text-[10.5px] text-muted-foreground",
            )}
          >
            {ROLE_LABEL[consult.role]}
          </span>
        )}

        <span
          className={cn(
            "flex items-center justify-end pr-4 text-[11.5px] font-medium",
            decision.tone,
          )}
        >
          {decision.text}
        </span>
      </UnstyledButton>
    </li>
  );
}

type LabelChange = {
  key: string;
  /** The segment the change starts. */
  segment: LabelSegment;
  cause: NonNullable<LabelSegment["cause"]>;
  /** What changed, in words: Trust → Suspicious, Audience → Internal. */
  parts: { field: string; to: string; tone: string }[];
  trustChanged: boolean;
  /** The row whose detail line notes it: the cause, else the first row under it. */
  noteKey: string;
  /** The row whose top (or, past the page's last row, bottom) edge carries the dot. */
  nodeKey: string;
  nodeAt: "top" | "bottom";
  /** What selecting the change selects. */
  target: { type: "consult" | "span"; key: string };
};

/**
 * The label changes this page shows: a dot wherever two rows' labels differ,
 * and a note on the row that caused each one.
 */
function pageChanges({
  entries,
  guardrails,
}: {
  entries: Entry[];
  guardrails: GuardrailsData;
}): LabelChange[] {
  const { labels } = guardrails;
  if (entries.length === 0) return [];
  const drawn = new Map(entries.map((entry) => [entry.key, entry]));
  const rowFor = (key: string | null) => (key ? drawn.get(key) : undefined);
  const out: LabelChange[] = [];
  const add = (index: number, nodeEntry: Entry, nodeAt: "top" | "bottom") => {
    const segment = labels[index];
    const { cause } = segment;
    if (!cause) return;
    const prev = labels[index - 1];
    const noteEntry =
      rowFor(cause.consultKey) ?? rowFor(cause.toolCallKey) ?? nodeEntry;
    out.push({
      key: `label-change-${segment.start}`,
      segment,
      cause,
      parts: describeChange(prev, segment),
      trustChanged: cause.kind === "reset" || prev.trust !== segment.trust,
      noteKey: noteEntry.key,
      nodeKey: nodeEntry.key,
      nodeAt,
      target: cause.consultKey
        ? { type: "consult", key: cause.consultKey }
        : {
            type: noteEntry.type === "consult" ? "consult" : "span",
            key: noteEntry.key,
          },
    });
  };
  const indexes = entries.map((entry) =>
    segmentIndexAt(
      labels,
      entry.type === "span" ? entry.span.start : entry.consult.start,
    ),
  );
  // Rows run in start order but a result check can trail a parallel call:
  // each change is placed once, at the first row under it.
  let reached = indexes[0];
  entries.forEach((entry, i) => {
    for (let s = reached + 1; s <= indexes[i]; s++) add(s, entry, "top");
    reached = Math.max(reached, indexes[i]);
  });
  // A change after the page's last row still shows under its cause.
  for (let s = reached + 1; s < labels.length; s++) {
    const cause = labels[s].cause;
    const row = cause
      ? (rowFor(cause.consultKey) ?? rowFor(cause.toolCallKey))
      : undefined;
    if (row) add(s, row, "bottom");
  }
  return out;
}

function segmentIndexAt(labels: LabelSegment[], ms: number): number {
  let hit = 0;
  for (let i = 0; i < labels.length; i++) {
    if (labels[i].start <= ms) hit = i;
    else break;
  }
  return hit;
}

function describeChange(
  prev: LabelSegment,
  next: LabelSegment,
): LabelChange["parts"] {
  if (next.cause?.kind === "reset") {
    return [
      {
        field: "Reset",
        to: `${TRUST_TONE[next.trust].label} · ${AUDIENCE_TONE[next.audience].label}`,
        tone: "text-foreground/80",
      },
    ];
  }
  const parts: LabelChange["parts"] = [];
  if (prev.trust !== next.trust) {
    parts.push({
      field: "Trust",
      to: TRUST_TONE[next.trust].label,
      tone: TRUST_TONE[next.trust].text,
    });
  }
  if (prev.audience !== next.audience) {
    parts.push({
      field: "Audience",
      to: AUDIENCE_TONE[next.audience].label,
      tone: AUDIENCE_TONE[next.audience].text,
    });
  }
  return parts.length > 0
    ? parts
    : [{ field: "Label", to: "set", tone: "text-foreground/80" }];
}

function changeWords(change: LabelChange): string {
  return change.parts.map((p) => `${p.field} → ${p.to}`).join(", ");
}

function causeShort(change: LabelChange): string {
  const { cause } = change;
  if (!cause.toolName) return "reset";
  return cause.kind === "reset"
    ? `reset by ${cause.toolName}`
    : `after ${cause.toolName}`;
}

const SELECTED_EDGE = "shadow-[inset_2px_0_0_var(--color-primary)]";
/** The selection's edge just right of the 8px gutter, which covers 0–8px. */
const SELECTED_PAST_GUTTER = "shadow-[inset_10px_0_0_var(--color-primary)]";
const GUTTER_FILL: Record<LabelState["trust"], string> = {
  trusted: "bg-emerald-500/40 dark:bg-emerald-400/35",
  suspicious: "bg-rose-500/70 dark:bg-rose-400/65",
};
const STRIPE_STYLE = {
  backgroundImage:
    "linear-gradient(135deg, var(--stripe) 25%, transparent 25%, transparent 50%, var(--stripe) 50%, var(--stripe) 75%, transparent 75%, transparent)",
  backgroundSize: "8px 8px",
};
const CHANGE_ICON: Record<
  NonNullable<LabelSegment["cause"]>["kind"],
  typeof ShieldAlert
> = {
  admitted: ShieldAlert,
  narrowed: Lock,
  released: Send,
  reset: RotateCcw,
};
