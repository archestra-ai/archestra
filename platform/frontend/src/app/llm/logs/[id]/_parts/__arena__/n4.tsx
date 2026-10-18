"use client";
// design-arena: do not commit

import {
  ChevronDown,
  CornerDownRight,
  Eye,
  EyeOff,
  Lock,
  MessageSquareText,
  RotateCcw,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import {
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
  const edges = consultRowSelected && openConsult ? openConsult : selected;
  const layout: Layout =
    spans.length > 0 && spans.every((span) => span.type === "tool")
      ? "tools"
      : "trace";
  /** Guardrails data adds a 6px label gutter in front of every row. */
  const guarded = guardrails != null;
  const grid = guarded ? GUARD_GRIDS[layout] : GRIDS[layout];
  const changesOnPage = entries.filter(
    (entry): entry is Extract<Entry, { type: "change" }> =>
      entry.type === "change",
  );
  const spanKeys = new Set(spans.map((span) => span.key));
  // A label change opens the check whose answer moved it when there is one,
  // else selects the tool call that caused it.
  const changeAction = (segment: LabelSegment): (() => void) | null => {
    const cause = segment.cause;
    if (cause?.consultKey && onSelectConsult) {
      const key = cause.consultKey;
      return () => onSelectConsult(key);
    }
    if (cause?.toolCallKey && spanKeys.has(cause.toolCallKey)) {
      const key = cause.toolCallKey;
      return () => {
        onSelect(key);
        rowRefs.current.get(key)?.focus({ preventScroll: true });
      };
    }
    return null;
  };
  const isChangeActive = (segment: LabelSegment) => {
    const cause = segment.cause;
    if (!cause) return false;
    if (cause.consultKey) return cause.consultKey === selectedConsultKey;
    return !consultRowSelected && cause.toolCallKey === selectedKey;
  };
  const blockedOnPage = consultsOnPage.filter((c) => c.decision === "blocked");
  const showNextBlocked = () => {
    if (blockedOnPage.length === 0) return;
    const index = blockedOnPage.findIndex((c) => c.key === selectedConsultKey);
    onSelectConsult?.(blockedOnPage[(index + 1) % blockedOnPage.length].key);
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
        <GuardrailsStrip
          consults={consultsOnPage}
          label={labelHere}
          labelName={labelHereName}
          changes={changesOnPage.map((entry) => ({
            key: entry.key,
            segment: entry.segment,
            previous: entry.previous,
            action: changeAction(entry.segment),
            active: isChangeActive(entry.segment),
          }))}
          checksShown={checksShown}
          onToggleChecks={() => setChecksShown((shown) => !shown)}
          onShowNextBlocked={onSelectConsult ? showNextBlocked : null}
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
            {guarded ? <div aria-hidden="true" /> : null}
            <div
              className={cn(
                "flex items-center gap-1.5",
                guarded ? "pl-2.5" : "pl-4",
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
            <WaterfallSkeleton layout={layout} grid={grid} guarded={guarded} />
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
                {guarded ? <div /> : null}
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
                {entries.map((entry) => {
                  if (entry.type === "change") {
                    return (
                      <LabelChangeRow
                        key={entry.key}
                        layout={layout}
                        grid={grid}
                        segment={entry.segment}
                        previous={entry.previous}
                        active={isChangeActive(entry.segment)}
                        onActivate={changeAction(entry.segment)}
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
                        grid={grid}
                        consult={consult}
                        toolSpan={entry.toolSpan}
                        gutter={entry.gutter}
                        connector={entry.connector}
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
                    grid,
                    gutter: entry.gutter,
                    stem: entry.stem,
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
/** The same grids behind a 6px label gutter, on phones and desktop alike. */
const GUARD_GRIDS: Record<Layout, string> = {
  trace:
    "grid-cols-[6px_minmax(0,1fr)_80px_68px] lg:grid-cols-[6px_minmax(232px,296px)_minmax(360px,1fr)_72px_84px]",
  tools:
    "grid-cols-[6px_minmax(0,1fr)_80px_68px] lg:grid-cols-[6px_minmax(232px,296px)_minmax(360px,1fr)_84px]",
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
  /** GRIDS, or GUARD_GRIDS when the label gutter leads every row. */
  grid: string;
  selected: boolean;
  /** Its check is the selection: the row reads as that check's parent. */
  ancestor?: boolean;
  /** The label in force at the row's start, drawn in the gutter. */
  gutter?: LabelState | null;
  /** Connector stubs out of the rail to the checks above and below. */
  stem?: Stem;
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
  selected,
  ancestor = false,
  gutter = null,
  stem = NO_STEM,
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
  const guarded = gutter != null;
  return (
    <li className="relative">
      <LabelGutter label={gutter} onClick={onSelect} />
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
            ? cn(
                "bg-primary/[0.07]",
                !guarded && "shadow-[inset_2px_0_0_var(--color-primary)]",
              )
            : ancestor
              ? "bg-primary/[0.035] hover:bg-primary/[0.06]"
              : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {guarded ? <span aria-hidden="true" /> : null}
        {/* Name over its detail line: model or server, then the clock
            time (phones show the latency there instead, having no axis
            labels). One rail in the kind's colour spans both lines. */}
        <span
          className={cn(
            "relative flex min-w-0 items-center gap-2 pr-3",
            guarded ? "pl-2.5" : "pl-4",
            guarded &&
              selected &&
              "shadow-[inset_2px_0_0_var(--color-primary)]",
          )}
        >
          {/* The rail runs on into the checks' connector. */}
          {stem.up ? (
            <span
              aria-hidden="true"
              className={cn(CONNECTOR_LINE, "top-0 h-1/2", stem.tone)}
            />
          ) : null}
          {stem.down ? (
            <span
              aria-hidden="true"
              className={cn(CONNECTOR_LINE, "top-1/2 -bottom-px", stem.tone)}
            />
          ) : null}
          <span
            className={cn(
              "relative h-[26px] w-[3px] shrink-0 rounded-full",
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

function WaterfallSkeleton({
  layout,
  grid,
  guarded,
}: {
  layout: Layout;
  grid: string;
  guarded: boolean;
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
          {guarded ? <div className="h-full bg-muted/70" /> : null}
          <div
            className={cn(
              "flex min-w-0 flex-col gap-1.5 pr-4",
              guarded ? "pl-2.5" : "pl-4",
            )}
          >
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
      stem: Stem;
    }
  | {
      type: "consult";
      key: string;
      consult: MockConsult;
      toolSpan: TimelineSpan | null;
      gutter: LabelState | null;
      connector: Connector;
    }
  | {
      type: "change";
      key: string;
      segment: LabelSegment;
      previous: LabelState;
    };

/** A tool call row's rail, continued up into its gates or down into its result checks. */
type Stem = { up: boolean; down: boolean; tone?: string };
const NO_STEM: Stem = { up: false, down: false };

/**
 * A check row's piece of the tree line out of its tool call's rail: "down"
 * opens it (┌, the first gate above the call), "through" carries it on (├),
 * "up" closes it (└, the last result check under the call). Null for a check
 * raised for no tool call on this page.
 */
type Connector = "down" | "through" | "up" | null;

/** The 1px tree line, centred under a row's 3px kind rail. */
const CONNECTOR_LINE =
  "pointer-events-none absolute left-[11px] w-px bg-muted-foreground/35";

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
      stem: NO_STEM,
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
      entry: consultEntry(consult, null, labelAt, null),
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
    const before = checksShown ? (bucket?.before ?? []) : [];
    const after = checksShown ? (bucket?.after ?? []) : [];
    before.forEach((c, i) => {
      out.push(consultEntry(c, span, labelAt, i === 0 ? "down" : "through"));
    });
    out.push({
      type: "span",
      key: span.key,
      span,
      gutter: labelAt(span.start),
      checks: bucket ? [...bucket.before, ...bucket.after] : [],
      stem: { up: before.length > 0, down: after.length > 0 },
    });
    after.forEach((c, i) => {
      out.push(
        consultEntry(
          c,
          span,
          labelAt,
          i === after.length - 1 ? "up" : "through",
        ),
      );
    });
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
  labelAt: (ms: number) => LabelState,
  connector: Connector,
): Entry {
  return {
    type: "consult",
    key: consult.key,
    consult,
    toolSpan,
    gutter: labelAt(consult.start),
    connector,
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

type StripChange = {
  key: string;
  segment: LabelSegment;
  previous: LabelState;
  /** Opens the check that moved it, or selects the call; null when neither is here. */
  action: (() => void) | null;
  active: boolean;
};

/**
 * One slim row under the header: the page's check count (blocked steps
 * through the blocked ones), an icon toggle for the check rows, and the
 * label key chip, whose popover holds the gutter's key and the changes.
 */
function GuardrailsStrip({
  consults,
  label,
  labelName,
  changes,
  checksShown,
  onToggleChecks,
  onShowNextBlocked,
}: {
  consults: MockConsult[];
  label: LabelState | null;
  labelName: string;
  changes: StripChange[];
  checksShown: boolean;
  onToggleChecks: () => void;
  onShowNextBlocked: (() => void) | null;
}) {
  const blocked = consults.filter((c) => c.decision === "blocked").length;
  const unanswered = consults.filter((c) => c.outcome !== "answered").length;
  return (
    <div className="flex h-8 min-w-0 items-center gap-x-2 border-b bg-muted/20 px-4 text-[11px] whitespace-nowrap text-muted-foreground">
      <span className="inline-flex min-w-0 items-center gap-1.5">
        <Shield
          className="size-3.5 shrink-0 text-foreground/70"
          aria-hidden="true"
        />
        <span className="tabular-nums">
          <span className="font-medium text-foreground/85">
            {consults.length}
          </span>{" "}
          {consults.length === 1 ? "check" : "checks"}
        </span>
      </span>
      {blocked > 0 ? (
        onShowNextBlocked ? (
          <UnstyledButton
            onClick={onShowNextBlocked}
            title="Open the next blocked check"
            className="-mx-1 inline-flex h-6 shrink-0 cursor-pointer items-center rounded px-1 font-medium text-rose-700 tabular-nums outline-none transition-colors hover:bg-rose-500/10 focus-visible:ring-2 focus-visible:ring-ring/60 dark:text-rose-300"
          >
            {blocked} blocked
          </UnstyledButton>
        ) : (
          <span className="shrink-0 text-rose-700 tabular-nums dark:text-rose-300">
            {blocked} blocked
          </span>
        )
      ) : null}
      {unanswered > 0 ? (
        <span className="shrink-0 text-amber-700 tabular-nums max-sm:hidden dark:text-amber-300">
          {unanswered} unanswered
        </span>
      ) : null}
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <UnstyledButton
            aria-pressed={checksShown}
            aria-label={checksShown ? "Hide check rows" : "Show check rows"}
            onClick={onToggleChecks}
            className={cn(
              "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
              !checksShown && "bg-muted text-foreground",
            )}
          >
            {checksShown ? (
              <Eye className="size-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="size-3.5" aria-hidden="true" />
            )}
          </UnstyledButton>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {checksShown
            ? "Hide check rows (their count stays on the tool call)"
            : "Show check rows under their tool calls"}
        </TooltipContent>
      </Tooltip>
      {label ? (
        <LabelKey label={label} labelName={labelName} changes={changes} />
      ) : null}
    </div>
  );
}

/**
 * The label key as one chip: the label here and the change count. Hover or
 * tap opens the full key and the page's changes, each a jump to its cause.
 */
function LabelKey({
  label,
  labelName,
  changes,
}: {
  label: LabelState;
  labelName: string;
  changes: StripChange[];
}) {
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openedByHover = useRef(false);
  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 180);
  };
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  const hoverHandlers = {
    onPointerEnter: (event: { pointerType: string }) => {
      if (event.pointerType !== "mouse") return;
      cancelClose();
      if (!open) openedByHover.current = true;
      setOpen(true);
    },
    onPointerLeave: (event: { pointerType: string }) => {
      if (event.pointerType === "mouse") scheduleClose();
    },
  };
  const narrowed = label.audience !== "public";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <UnstyledButton
          {...hoverHandlers}
          onClick={(event) => {
            // A click after a hover-open keeps it open instead of toggling.
            event.preventDefault();
            setOpen((wasOpen) => (openedByHover.current ? true : !wasOpen));
            openedByHover.current = false;
          }}
          aria-label={`Session label at ${labelName}: ${TRUST_TONE[label.trust].label}, audience ${AUDIENCE_TONE[label.audience].label}. ${changes.length} label ${changes.length === 1 ? "change" : "changes"} on this page. Show the key.`}
          className={cn(
            "ml-auto inline-flex h-6 min-w-0 shrink cursor-pointer items-center gap-1.5 rounded-md border bg-card pr-1 pl-1.5 text-foreground/85 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60",
            open && "bg-muted",
          )}
        >
          <GutterSwatch label={label} />
          <span className="font-medium">Label</span>
          <span className="truncate text-muted-foreground max-md:hidden">
            {TRUST_TONE[label.trust].label}
            {narrowed ? ` · ${AUDIENCE_TONE[label.audience].label}` : ""}
          </span>
          {changes.length > 0 ? (
            <span className="inline-flex shrink-0 items-center rounded-sm bg-muted px-1 leading-4 font-medium tabular-nums text-foreground/80">
              {changes.length}
              <span className="max-sm:hidden">
                &nbsp;{changes.length === 1 ? "change" : "changes"}
              </span>
            </span>
          ) : null}
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </UnstyledButton>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        {...hoverHandlers}
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-[min(320px,calc(100vw-32px))] p-0 text-xs"
      >
        <div className="border-b px-3 py-2">
          <p className="text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
            Session label at {labelName}
          </p>
          <p className="mt-0.5 flex items-center gap-1.5">
            <GutterSwatch label={label} />
            <span className={cn("font-medium", TRUST_TONE[label.trust].text)}>
              {TRUST_TONE[label.trust].label}
            </span>
            <span className="text-muted-foreground">·</span>
            <span
              className={cn("font-medium", AUDIENCE_TONE[label.audience].text)}
            >
              {AUDIENCE_TONE[label.audience].label}
            </span>
          </p>
        </div>
        <ul
          aria-label="Gutter key"
          className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1.5 border-b px-3 py-2 text-muted-foreground"
        >
          <KeyLine swatch={<GutterSwatch label={TRUSTED_PUBLIC} />}>
            <span className="text-foreground/85">Trusted</span>, audience public
          </KeyLine>
          <KeyLine
            swatch={
              <GutterSwatch
                label={{ trust: "suspicious", audience: "public" }}
              />
            }
          >
            <span className="text-foreground/85">Suspicious</span>: holds
            third-party content
          </KeyLine>
          <KeyLine
            swatch={
              <GutterSwatch
                label={{ trust: "trusted", audience: "internal" }}
              />
            }
          >
            <span className="text-foreground/85">Hollow</span> = audience
            narrowed (internal, a team, self)
          </KeyLine>
          <KeyLine
            swatch={
              <ShieldCheck
                aria-hidden="true"
                className="mx-auto size-3.5 text-muted-foreground"
              />
            }
          >
            A check row under its tool call; click it for details
          </KeyLine>
        </ul>
        <div className="px-1.5 py-1.5">
          <p className="px-1.5 pb-1 text-[10.5px] font-medium tracking-wide text-muted-foreground uppercase">
            {changes.length === 0
              ? "No label changes on this page"
              : `Changes on this page · ${changes.length}`}
          </p>
          {changes.length > 0 ? (
            <ul className="max-h-48 overflow-y-auto">
              {changes.map((change) => {
                const parts = describeChange(change.previous, change.segment);
                const body = (
                  <>
                    <ChangePill parts={parts} active={change.active} />
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {change.segment.cause?.summary}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/80 tabular-nums">
                      {clock(change.segment.start)}
                    </span>
                  </>
                );
                return (
                  <li key={change.key}>
                    {change.action ? (
                      <UnstyledButton
                        onClick={() => {
                          change.action?.();
                          setOpen(false);
                        }}
                        title={causeHint(change.segment)}
                        className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60"
                      >
                        {body}
                      </UnstyledButton>
                    ) : (
                      <div className="flex h-7 min-w-0 items-center gap-2 px-1.5">
                        {body}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function KeyLine({
  swatch,
  children,
}: {
  swatch: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="contents">
      <span className="flex w-4 justify-center">{swatch}</span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The 6px label gutter down every row's left edge: filled by trust, and
 * hollow (a light tint with a 1px inner edge) while the audience is
 * narrower than public. Every row paints its own slice edge to edge, its
 * border included, so the column reads as one continuous strip. The hover
 * target is 16px wide, reaching into the name cell's empty padding.
 */
function LabelGutter({
  label,
  onClick,
  note,
}: {
  label: LabelState | null;
  /** The row's own action, so a click on the gutter still selects it. */
  onClick?: () => void;
  /** Overrides the tooltip's second line (a change row says what changed). */
  note?: string;
}) {
  if (!label) return null;
  const narrowed = label.audience !== "public";
  return (
    <Tooltip delayDuration={250}>
      <TooltipTrigger asChild>
        <span
          aria-hidden="true"
          onClick={onClick}
          className="absolute inset-y-0 left-0 z-[3] w-4 cursor-default"
        >
          <GutterFill
            label={label}
            className="absolute inset-y-0 left-0 w-[6px]"
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="right" className="max-w-xs">
        <p>
          <span className={cn("font-medium", TRUST_TONE[label.trust].text)}>
            {TRUST_TONE[label.trust].label}
          </span>
          <span className="opacity-60"> · </span>
          <span
            className={cn("font-medium", AUDIENCE_TONE[label.audience].text)}
          >
            {AUDIENCE_TONE[label.audience].label}
          </span>
        </p>
        <p className="opacity-70">
          {note ??
            (narrowed
              ? "Session label here; audience narrowed"
              : "Session label here")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

function GutterFill({
  label,
  className,
}: {
  label: LabelState;
  className?: string;
}) {
  const fill = GUTTER[label.trust];
  const narrowed = label.audience !== "public";
  return (
    <span className={cn(narrowed ? fill.tint : fill.solid, className)}>
      {narrowed ? (
        <span className={cn("absolute inset-y-0 right-0 w-px", fill.edge)} />
      ) : null}
    </span>
  );
}

/** A slice of the gutter, as the key and the chip draw it. */
function GutterSwatch({ label }: { label: LabelState }) {
  return (
    <span
      aria-hidden="true"
      className="relative inline-flex h-3.5 w-[6px] shrink-0 overflow-hidden rounded-[1px]"
    >
      <GutterFill label={label} className="absolute inset-0" />
    </span>
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
      title={`${checks.length} guardrail ${checks.length === 1 ? "check" : "checks"}; show check rows to open them`}
    >
      <DecisionIcon consult={worst} className="size-3" />
      {checks.length}
    </span>
  );
}

/**
 * A guardrail check as a 28px row hung off its tool call's rail by a tree
 * line (┌ ├ └): gates above the call, result checks below. The whole row
 * opens it in the pane below.
 */
function ConsultRow({
  layout,
  grid,
  consult,
  toolSpan,
  gutter,
  connector,
  selected,
  buttonRef,
  onSelect,
}: {
  layout: Layout;
  grid: string;
  consult: MockConsult;
  toolSpan: TimelineSpan | null;
  gutter: LabelState | null;
  connector: Connector;
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
  const guarded = gutter != null;
  const lineTone = selected ? "bg-primary/70" : undefined;
  return (
    <li className="relative">
      <LabelGutter label={gutter} onClick={onSelect} />
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        aria-label={`Guardrail check ${consult.externalName}, ${what}: ${decision.text}. Opens its details below.`}
        className={cn(
          "group grid h-7 w-full cursor-pointer scroll-mt-8 scroll-mb-1 border-b border-border/30 text-left text-xs outline-none transition-colors duration-100",
          grid,
          selected ? "bg-primary/[0.07]" : "hover:bg-muted/60",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {guarded ? <span aria-hidden="true" /> : null}
        <span
          className={cn(
            "relative flex min-w-0 items-center gap-1.5 pr-3",
            guarded ? "pl-[26px]" : "pl-[32px]",
            selected && "shadow-[inset_2px_0_0_var(--color-primary)]",
          )}
        >
          {connector ? (
            <>
              <span
                aria-hidden="true"
                className={cn(
                  CONNECTOR_LINE,
                  !guarded && "left-[17px]",
                  connector === "down"
                    ? "top-1/2 -bottom-px"
                    : connector === "up"
                      ? "top-0 h-1/2"
                      : "top-0 -bottom-px",
                  lineTone,
                )}
              />
              <span
                aria-hidden="true"
                className={cn(
                  CONNECTOR_LINE,
                  "top-1/2 h-px w-[10px]",
                  !guarded && "left-[17px]",
                  lineTone,
                )}
              />
            </>
          ) : null}
          <DecisionIcon
            consult={consult}
            className={cn(
              "size-3.5",
              selected && consult.decision !== "blocked" && "text-primary",
            )}
          />
          <span
            className={cn(
              "truncate font-mono text-[11.5px]",
              selected
                ? "font-semibold text-foreground"
                : "font-medium text-foreground/85",
            )}
          >
            {consult.externalName}
          </span>
          <span
            className={cn(
              "shrink-0 text-[10.5px] max-sm:hidden",
              selected ? "text-foreground/60" : "text-muted-foreground/80",
            )}
          >
            {consult.beforeCall ? "gate" : "on result"}
          </span>
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
            "flex items-center justify-end pr-4 text-[11px] font-medium",
            decision.tone,
          )}
        >
          {decision.text}
        </span>
      </UnstyledButton>
    </li>
  );
}

/**
 * Where the session's label changed: a hairline across the list with the
 * change as a pill on it and the cause beside. The row opens the check whose
 * answer moved the label, else selects the tool call that caused it.
 */
function LabelChangeRow({
  layout,
  grid,
  segment,
  previous,
  active,
  onActivate,
}: {
  layout: Layout;
  grid: string;
  segment: LabelSegment;
  previous: LabelState;
  active: boolean;
  onActivate: (() => void) | null;
}) {
  const parts = describeChange(previous, segment);
  const cause = segment.cause;
  const causeText = cause?.toolName
    ? cause.kind === "reset"
      ? `reset by ${cause.toolName}`
      : `after ${cause.toolName}`
    : "reset";
  const words = parts.parts.map((p) => `${p.field} → ${p.to}`).join(", ");
  const label = `Label changed: ${words}. ${cause?.summary ?? ""}`;
  const time = clock(segment.start);
  const className = cn(
    "relative grid h-6 w-full text-left text-[11px]",
    grid,
    onActivate &&
      "group cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
  );
  const body = (
    <>
      {/* The hairline, from the gutter to the far edge. */}
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute top-1/2 right-0 left-[6px] h-px",
          active ? "bg-primary/50" : "bg-border",
          onActivate && "group-hover:bg-foreground/25",
        )}
      />
      <span aria-hidden="true" />
      <span className="relative flex min-w-0 items-center gap-1.5 pr-2 pl-2.5">
        <span className="shrink-0 rounded-full bg-card">
          <ChangePill parts={parts} active={active} />
        </span>
        <span className="min-w-0 truncate bg-card pr-1 font-mono text-[10.5px] text-muted-foreground lg:hidden">
          {causeText}
        </span>
      </span>
      <span className="relative mx-2 block lg:mx-3">
        <span
          aria-hidden="true"
          className={cn(
            "absolute top-1/2 size-[7px] -translate-x-1/2 -translate-y-1/2 rotate-45 rounded-[1px] ring-2 ring-card",
            TRUST_TONE[segment.trust].bar,
          )}
          style={{ left: `${segment.x * 100}%` }}
        />
        <span
          className="absolute top-1/2 hidden max-w-[62%] -translate-y-1/2 truncate bg-card px-1 text-muted-foreground lg:block"
          style={
            segment.x < 0.55
              ? { left: `calc(${segment.x * 100}% + 6px)` }
              : { right: `calc(${(1 - segment.x) * 100}% + 6px)` }
          }
        >
          <span className="font-mono text-foreground/75">{causeText}</span>
          {cause ? ` · ${cause.summary}` : null}
        </span>
      </span>
      {layout === "trace" ? <span className="hidden lg:block" /> : null}
      <span className="relative flex items-center justify-end pr-4">
        <span className="bg-card pl-1 text-[10.5px] text-muted-foreground/80 tabular-nums max-lg:hidden">
          {time}
        </span>
      </span>
    </>
  );
  return (
    <li className="relative">
      <LabelGutter
        label={{ trust: segment.trust, audience: segment.audience }}
        onClick={onActivate ?? undefined}
        note={`From here: ${words}`}
      />
      {onActivate ? (
        <UnstyledButton
          onClick={onActivate}
          aria-label={`${label} ${causeHint(segment)}`}
          title={causeHint(segment)}
          className={className}
        >
          {body}
        </UnstyledButton>
      ) : (
        <div role="note" aria-label={label} className={className}>
          {body}
        </div>
      )}
    </li>
  );
}

type ChangeParts = {
  /** What changed, in words: "Trust → Suspicious", "Audience → Internal". */
  parts: { field: string; to: string }[];
  /** Pill tone, from the most significant part. */
  tone: string;
  Icon: typeof ShieldAlert;
};

function describeChange(prev: LabelState, next: LabelSegment): ChangeParts {
  const Icon = CHANGE_ICON[next.cause?.kind ?? "reset"];
  if (next.cause?.kind === "reset") {
    return {
      parts: [
        {
          field: "Reset",
          to: `${TRUST_TONE[next.trust].label} · ${AUDIENCE_TONE[next.audience].label}`,
        },
      ],
      tone: RESET_PILL,
      Icon,
    };
  }
  const parts: ChangeParts["parts"] = [];
  let tone = RESET_PILL;
  if (prev.audience !== next.audience) {
    parts.push({ field: "Audience", to: AUDIENCE_TONE[next.audience].label });
    tone = AUDIENCE_PILL[next.audience];
  }
  if (prev.trust !== next.trust) {
    parts.unshift({ field: "Trust", to: TRUST_TONE[next.trust].label });
    tone = TRUST_PILL[next.trust];
  }
  return { parts, tone, Icon };
}

function ChangePill({
  parts,
  active,
}: {
  parts: ChangeParts;
  active: boolean;
}) {
  const { Icon } = parts;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 text-[10px] leading-4 font-semibold whitespace-nowrap ring-1 ring-inset",
        parts.tone,
        active && "ring-2 ring-primary",
      )}
    >
      <Icon className="size-2.5 shrink-0" aria-hidden="true" />
      {parts.parts.map((part, index) => (
        <span key={part.field} className="inline-flex items-center gap-0.5">
          {index > 0 ? <span className="opacity-50">·</span> : null}
          <span className="font-medium opacity-80">{part.field}</span>
          <span aria-hidden="true">→</span>
          <span>{part.to}</span>
        </span>
      ))}
    </span>
  );
}

function causeHint(segment: LabelSegment): string {
  const cause = segment.cause;
  if (cause?.consultKey) return "Opens the check that set it.";
  if (cause?.toolCallKey) {
    return `Selects ${cause.toolName ?? "the tool call"}, which caused it.`;
  }
  return "No tool call caused this change.";
}

function clock(ms: number): string {
  return formatDate({
    date: new Date(ms).toISOString(),
    dateFormat: "HH:mm:ss",
  });
}

const TRUSTED_PUBLIC: LabelState = { trust: "trusted", audience: "public" };
const GUTTER: Record<Trust, { solid: string; tint: string; edge: string }> = {
  trusted: {
    solid: "bg-emerald-500/55 dark:bg-emerald-400/50",
    tint: "bg-emerald-500/15 dark:bg-emerald-400/15",
    edge: "bg-emerald-600/80 dark:bg-emerald-400/80",
  },
  suspicious: {
    solid: "bg-rose-500/75 dark:bg-rose-400/70",
    tint: "bg-rose-500/20 dark:bg-rose-400/20",
    edge: "bg-rose-600 dark:bg-rose-400",
  },
};
const TRUST_PILL: Record<Trust, string> = {
  suspicious:
    "bg-rose-500/15 text-rose-700 ring-rose-500/40 dark:text-rose-300",
  trusted:
    "bg-emerald-500/15 text-emerald-700 ring-emerald-500/40 dark:text-emerald-300",
};
const AUDIENCE_PILL: Record<Audience, string> = {
  public: "bg-sky-500/15 text-sky-700 ring-sky-500/40 dark:text-sky-300",
  internal:
    "bg-indigo-500/15 text-indigo-700 ring-indigo-500/40 dark:text-indigo-300",
  "@payments":
    "bg-violet-500/15 text-violet-700 ring-violet-500/40 dark:text-violet-300",
  self: "bg-fuchsia-500/15 text-fuchsia-700 ring-fuchsia-500/40 dark:text-fuchsia-300",
};
const RESET_PILL = "bg-muted text-foreground/80 ring-border";
const CHANGE_ICON: Record<
  NonNullable<LabelSegment["cause"]>["kind"],
  typeof ShieldAlert
> = {
  admitted: ShieldAlert,
  narrowed: Lock,
  released: Send,
  reset: RotateCcw,
};
