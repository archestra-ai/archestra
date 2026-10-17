"use client";

import {
  ArrowRight,
  CornerDownRight,
  MessageSquareText,
  X,
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
import { Kbd } from "@/components/ui/kbd";
import { Skeleton } from "@/components/ui/skeleton";
import { TablePagination } from "@/components/ui/table-pagination";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { readMcpToolCall } from "@/lib/mcp-logs/tool-call-content";
import type { McpServerDisplay } from "@/lib/mcp-logs/use-mcp-server-display";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed, formatLatency } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import {
  type RequestSpan,
  requestLabel,
  SPAN_KINDS,
  type SpanKind,
  type Timeline,
  type TimelineSpan,
  type ToolCallSpan,
} from "./session-timeline";

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
  pagination,
  totalRequests,
  notice,
  action,
}: {
  timeline: Timeline | null;
  loading: boolean;
  profileName: string | null;
  /** Catalog names and icons for the servers tool calls went to. */
  serverDisplayByName: Map<string, McpServerDisplay>;
  /** The request whose conversation is loaded, marked in its row. */
  conversationRowId: string | null;
  selectedKey: string | null;
  /**
   * A span the URL pointed at: ringed so it stands out, and scrolled into
   * the page's view once on arrival.
   */
  highlightedKey: string | null;
  onSelect: (key: string) => void;
  onOpen: (span: TimelineSpan) => void;
  pagination: RequestsPagination | null;
  totalRequests: number;
  /** Shown between the header and the list, such as a failed load. */
  notice?: ReactNode;
  /** The card's own control (Export JSON), placed beside the title. */
  action: ReactNode;
}) {
  const spans = timeline?.spans ?? [];
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const scrollerRef = useRef<HTMLDivElement>(null);
  const selected = spans.find((span) => span.key === selectedKey) ?? null;

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
    if (scroller && row) scrollWithin(scroller, row);
  }, [selectedKey]);

  const revealedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!highlightedKey || revealedKey.current === highlightedKey) return;
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
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">Requests</h2>
          <span className="text-xs text-muted-foreground tabular-nums">
            {pagination
              ? `${(pagination.offset + 1).toLocaleString()}–${Math.min(
                  pagination.offset + pagination.pageSize,
                  pagination.total,
                ).toLocaleString()} of ${pagination.total.toLocaleString()}`
              : `${totalRequests.toLocaleString()} total`}
          </span>
        </div>
        {/* Phones: the action ends the title line and the legend gets a
            line of its own. Wide: the legend and the action share the right
            end. */}
        <div className="order-2 ml-auto lg:order-4 lg:ml-0">{action}</div>
        <div className="order-3 flex w-full flex-wrap items-center gap-x-5 gap-y-1 lg:ml-auto lg:w-auto">
          <ul
            aria-label="Request kinds"
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
          >
            {(Object.keys(SPAN_KINDS) as SpanKind[]).map((kind) => (
              <li
                key={kind}
                className={cn(
                  "inline-flex items-center gap-1.5",
                  kindCounts[kind] === 0 && "opacity-40",
                )}
              >
                <span
                  className={cn("h-2 w-3 rounded-[2px]", SPAN_KINDS[kind].bar)}
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
            <span className="ml-1">
              to step · Enter or double-click to open
            </span>
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
              "sticky top-0 z-20 grid h-8 border-b bg-muted text-[11px] text-muted-foreground",
              GRID,
            )}
          >
            <div className="flex items-center pl-4">Name</div>
            <div className={cn(WIDE_ONLY, "items-center px-2")}>Model</div>
            <div className={cn(WIDE_ONLY, "items-center px-2")}>Time</div>
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
            <div className={cn(WIDE_ONLY, "items-center justify-end px-3")}>
              Tokens
            </div>
            <div className="flex items-center justify-end pr-4">Cost</div>
          </div>

          {loading ? (
            <WaterfallSkeleton />
          ) : !timeline || spans.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-muted-foreground">
              No requests recorded for this session yet.
            </p>
          ) : (
            <div className="relative">
              {/* Gridlines, idle breaks and the selection's edges, behind
                  every row. */}
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-0 grid",
                  GRID,
                )}
              >
                <div />
                <div className="hidden lg:block" />
                <div className="hidden lg:block" />
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
                <div className="hidden lg:block" />
                <div />
              </div>

              <ol
                className="relative"
                onKeyDown={onKeyDown}
                aria-label="Requests"
              >
                {spans.map((span) => {
                  const rowProps = {
                    selected: span.key === selectedKey,
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
      <div className="border-t bg-muted/40 px-4 py-1.5">
        {pagination && pagination.total > pagination.pageSize ? (
          <TablePagination
            pageIndex={pagination.pageIndex}
            pageSize={pagination.pageSize}
            total={pagination.total}
            onPaginationChange={pagination.onPaginationChange}
            leftContent={
              <StatusText
                requests={spans.length - kindCounts.tool}
                toolCalls={kindCounts.tool}
                tokens={pageTotals.tokens}
                billed={pageTotals.billed}
                timeline={timeline}
              />
            }
          />
        ) : (
          <div className="flex h-8 items-center text-muted-foreground">
            <StatusText
              requests={spans.length - kindCounts.tool}
              toolCalls={kindCounts.tool}
              tokens={pageTotals.tokens}
              billed={pageTotals.billed}
              timeline={timeline}
            />
          </div>
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

// ============================================================================
// Internal helpers
// ============================================================================

// Phones keep Name, a compact track and Cost; the Model, Time and Tokens
// cells are display:none there, so they take no grid track.
const GRID =
  "grid-cols-[minmax(0,1fr)_80px_68px] lg:grid-cols-[minmax(190px,1.25fr)_148px_64px_minmax(260px,2.6fr)_108px_84px]";
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
  // Phones keep the three figures that matter (the session's span is already
  // in the facts strip); separators only exist where it is all one line.
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
    <span className="flex items-center gap-x-3 text-xs whitespace-nowrap tabular-nums lg:gap-x-2">
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
  const nearEnd = span.x + span.w > 0.84;
  return (
    <li>
      <UnstyledButton
        ref={buttonRef}
        tabIndex={selected ? 0 : -1}
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        onDoubleClick={onOpen}
        aria-label={label}
        className={cn(
          "group grid h-11 w-full scroll-mt-8 scroll-mb-1 border-b border-border/50 text-left text-xs outline-none lg:h-8",
          GRID,
          selected
            ? "bg-primary/[0.07] shadow-[inset_2px_0_0_var(--color-primary)]"
            : "hover:bg-muted/50",
          highlighted && "ring-2 ring-primary/50 ring-inset",
          "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset",
        )}
      >
        {/* Name; phones fold the detail line under it */}
        <span className="flex min-w-0 items-center gap-2 pr-2 pl-4">
          <span
            className={cn("h-4 w-[3px] shrink-0 rounded-full", style.bar)}
            aria-hidden="true"
          />
          {span.kind !== "main" ? (
            <CornerDownRight
              className="size-3 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            />
          ) : null}
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">{name}</span>
            <span className="flex min-w-0 items-center text-[11px] leading-4 text-muted-foreground tabular-nums lg:hidden">
              {detail}
              <span className="shrink-0">&nbsp;· {latency?.text ?? "—"}</span>
            </span>
          </span>
        </span>

        {/* Model, or the server a tool call went to */}
        <span
          className={cn(
            WIDE_ONLY,
            "min-w-0 items-center gap-1.5 px-2 text-muted-foreground",
          )}
        >
          {detail}
        </span>

        {/* Time */}
        <span
          className={cn(
            WIDE_ONLY,
            "items-center px-2 text-muted-foreground tabular-nums",
          )}
        >
          {time}
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
          {latency ? (
            <span
              role="img"
              aria-label={latency.label}
              className={cn(
                "pointer-events-none absolute top-1/2 hidden -translate-y-1/2 text-[11px] whitespace-nowrap tabular-nums lg:block",
                selected ? "text-foreground" : "text-muted-foreground",
              )}
              style={
                nearEnd
                  ? { right: `calc(${(1 - span.x) * 100}% + 6px)` }
                  : { left: `calc(${(span.x + span.w) * 100}% + 8px)` }
              }
            >
              {latency.text}
            </span>
          ) : null}
        </span>

        {/* Tokens */}
        <span
          className={cn(
            WIDE_ONLY,
            "items-center justify-end gap-1 px-3 text-muted-foreground tabular-nums",
          )}
        >
          {tokens}
        </span>

        {/* Cost */}
        <span className="flex items-center justify-end gap-1.5 pr-4 tabular-nums">
          {cost}
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
      label={`${label}, ${modelName}, ${latency}${isConversation ? ", conversation loaded" : ""}`}
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
              size={16}
              ring={false}
            />
          </span>
          <span className="truncate" title={row.model ?? undefined}>
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
      tokens={
        <>
          <span>{formatCompactNumber(row.inputTokens ?? 0)}</span>
          <ArrowRight
            className="size-3 text-muted-foreground/50"
            aria-hidden="true"
          />
          <span className="text-foreground/80">
            {formatCompactNumber(row.outputTokens ?? 0)}
          </span>
        </>
      }
      cost={
        <>
          {onPlan ? (
            <span className="hidden rounded-sm bg-muted px-1 text-[10px] leading-4 font-medium text-muted-foreground lg:inline">
              Plan
            </span>
          ) : null}
          <span
            className={cn("font-medium", onPlan && "text-muted-foreground")}
          >
            {formatRequestCost(Number(row.cost ?? 0))}
          </span>
        </>
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
  const failed = content.status === "error";

  return (
    <RowShell
      span={span}
      {...rowProps}
      label={`Tool call ${name} on ${server}, ${latency}${failed ? ", failed" : ""}`}
      name={
        <>
          <span className="truncate font-mono text-[12px] font-medium">
            {name}
          </span>
          <KindChip kind="tool" />
          {failed ? (
            <X
              className="size-3.5 shrink-0 text-destructive"
              aria-hidden="true"
            />
          ) : null}
        </>
      }
      detail={
        <>
          <span className="hidden shrink-0 lg:flex">
            <McpCatalogIcon
              icon={display?.icon}
              catalogId={display?.catalogId}
              size={14}
            />
          </span>
          <span className="truncate">{server}</span>
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

function WaterfallSkeleton() {
  return (
    <div>
      {SKELETON_PLACEMENTS.map(([x, w]) => (
        <div
          key={x}
          className={cn(
            "grid h-11 items-center border-b border-border/50 lg:h-8",
            GRID,
          )}
        >
          <div className="min-w-0 px-4">
            <Skeleton className="h-3 w-32 max-w-full" />
          </div>
          <div className="hidden px-2 lg:block">
            <Skeleton className="h-3 w-20" />
          </div>
          <div className="hidden px-2 lg:block">
            <Skeleton className="h-3 w-12" />
          </div>
          <div className="relative mx-2 h-full lg:mx-3">
            <Skeleton
              className="absolute top-1/2 h-2.5 -translate-y-1/2"
              style={{ left: `${x}%`, width: `${w}%` }}
            />
          </div>
          <div className="hidden justify-end px-3 lg:flex">
            <Skeleton className="h-3 w-14" />
          </div>
          <div className="flex justify-end pr-4">
            <Skeleton className="h-3 w-10" />
          </div>
        </div>
      ))}
    </div>
  );
}
