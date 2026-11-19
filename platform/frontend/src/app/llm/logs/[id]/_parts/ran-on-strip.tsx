"use client";

import { ArrowDownLeft, ArrowUpRight, Container, Laptop } from "lucide-react";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { formatUsageCost } from "@/app/llm/logs/_parts/logs-table-format";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatDate } from "@/lib/utils/date-time";
import { formatElapsed } from "@/lib/utils/format-duration";
import { cn } from "@/lib/utils/tailwind";
import type { RanOnKnob, RanOnMove, RanOnSegment, RanOnView } from "./ran-on";
import { GRIDS, type Layout, WIDE_ONLY } from "./waterfall-grid";

/** Who is on either side of the handoff, and where each side's page is. */
export type RanOnParties = {
  /** The client the work started in, such as "Claude Code". */
  clientLabel: string;
  /**
   * The session that handed this one its work, when it is a run's own:
   * named, with its trace's link.
   */
  origin: { label: string; href: string } | null;
  /** The runs on the strip, oldest first. */
  runs: RanOnRun[];
};

type RanOnRun = {
  runId: string;
  /** The Agent Runtime agent that took the work. */
  agentName: string;
  /** The run's own page: its terminal and history. */
  href: string;
};

/**
 * Where the session's work ran, above the request list: a strip on the
 * timeline's axis from `lg`, one line on phones (the row gutter carries the
 * rest there).
 */
export function RanOnHeader({
  view,
  parties,
  layout,
}: {
  view: RanOnView;
  parties: RanOnParties;
  layout: Layout;
}) {
  return (
    <>
      <RanOnStrip view={view} parties={parties} layout={layout} />
      <RanOnLine view={view} parties={parties} />
    </>
  );
}

/**
 * Phones: rows that ran in Agent Runtime get a faint tint across the row and
 * a solid lane in the row gutter, with a small knob where the work changed
 * hands. The timeline column is too narrow there for the move hairlines.
 */
export function RanOnLane({
  runtime,
  knob,
}: {
  runtime: boolean;
  knob: RanOnKnob | undefined;
}) {
  if (!runtime && !knob) return null;
  return (
    <span aria-hidden="true" className="lg:hidden">
      {runtime ? (
        <>
          <span className="pointer-events-none absolute inset-0 bg-indigo-500/[0.07] dark:bg-indigo-400/[0.08]" />
          <span className="pointer-events-none absolute inset-y-0 left-[5px] z-[1] w-[3px] bg-indigo-500/70 dark:bg-indigo-400/70" />
        </>
      ) : null}
      {knob ? (
        <span
          className={cn(
            "pointer-events-none absolute left-px z-[2] flex size-[11px] items-center justify-center rounded-full border border-indigo-500/60 bg-card text-indigo-600 dark:border-indigo-400/60 dark:text-indigo-300",
            knob.edge === "top" ? "-top-[6px]" : "-bottom-[6px]",
          )}
        >
          {knob.kind === "pull" ? (
            <ArrowDownLeft className="size-2" />
          ) : (
            <ArrowUpRight className="size-2" />
          )}
        </span>
      ) : null}
    </span>
  );
}

/** A row's mark on its detail line that it ran in Agent Runtime. */
export function RuntimeGlyph() {
  return (
    <span
      role="img"
      aria-label="Ran in Agent Runtime"
      title="Ran in Agent Runtime"
      className="inline-flex shrink-0"
    >
      <Container
        className="size-3 text-indigo-600/80 dark:text-indigo-300/80"
        aria-hidden="true"
      />
    </span>
  );
}

/** Faint hairlines under the rows where the work changed hands; not on phones. */
export function RanOnMoveLines({ view }: { view: RanOnView }) {
  return (
    <>
      {view.moves
        .filter((move) => move.x > 0 && move.x < 1)
        .map((move) => (
          <span
            key={`ran-on-${move.key}`}
            className="absolute inset-y-0 w-px bg-indigo-500/20 max-lg:hidden dark:bg-indigo-400/20"
            style={{ left: `${move.x * 100}%` }}
          />
        ))}
    </>
  );
}

// ============================================================================

const SEGMENT_STYLE = {
  client:
    "bg-muted text-muted-foreground ring-1 ring-inset ring-border hover:bg-muted/70",
  runtime:
    "bg-indigo-500/10 text-indigo-700 ring-1 ring-inset ring-indigo-500/25 hover:bg-indigo-500/15 dark:bg-indigo-400/15 dark:text-indigo-300 dark:ring-indigo-400/30 dark:hover:bg-indigo-400/20",
  elsewhere:
    "border border-dashed border-border bg-[repeating-linear-gradient(135deg,transparent_0_4px,var(--color-border)_4px_5px)] text-muted-foreground hover:text-foreground",
};

function RanOnStrip({
  view,
  parties,
  layout,
}: {
  view: RanOnView;
  parties: RanOnParties;
  layout: Layout;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled strip, not a form group
    <div
      role="group"
      aria-label="Where this session ran"
      className={cn(
        "hidden h-9 border-b bg-card text-[11px] tabular-nums lg:grid",
        GRIDS[layout],
      )}
    >
      <div className="flex min-w-0 items-center gap-2 pr-3 pl-4">
        <span
          aria-hidden="true"
          className="flex h-[22px] w-[3px] shrink-0 flex-col overflow-hidden rounded-full"
        >
          <span className="flex-1 bg-muted-foreground/35" />
          <span className="flex-1 bg-indigo-500 dark:bg-indigo-400" />
        </span>
        <span className="flex min-w-0 flex-col leading-4">
          <span className="font-medium text-foreground/80">Ran on</span>
          <Counts view={view} parties={parties} />
        </span>
      </div>
      <div className="relative mx-2 lg:mx-3">
        {view.segments.map((segment) => (
          <SegmentBar
            key={segment.key}
            segment={segment}
            parties={parties}
            runs={segment.runIds.flatMap(
              (runId) => runOf(parties, runId) ?? [],
            )}
          />
        ))}
        {view.moves.map((move) => (
          <MoveKnob
            key={move.key}
            move={move}
            parties={parties}
            run={runOf(parties, move.runId)}
          />
        ))}
      </div>
      {layout === "trace" ? <div className="hidden lg:block" /> : null}
      <div />
    </div>
  );
}

function RanOnLine({
  view,
  parties,
}: {
  view: RanOnView;
  parties: RanOnParties;
}) {
  return (
    <div className="flex h-8 items-center gap-2 border-b bg-card pr-4 pl-[5px] text-[11px] whitespace-nowrap text-muted-foreground tabular-nums lg:hidden">
      <span
        aria-hidden="true"
        className="h-4 w-[3px] shrink-0 rounded-full bg-indigo-500 dark:bg-indigo-400"
      />
      <span className="ml-1.5 font-medium text-foreground/80">Ran on</span>
      <Counts view={view} parties={parties} />
      <span className="ml-auto inline-flex shrink-0 items-center gap-2">
        {parties.origin ? (
          <Link
            href={parties.origin.href}
            className="inline-flex items-center gap-0.5 hover:text-foreground"
          >
            <span>{parties.origin.label}</span>
            <ArrowUpRight className="size-3" aria-hidden="true" />
          </Link>
        ) : null}
        {parties.runs.map((run) => (
          <Link
            key={run.runId}
            href={run.href}
            className="inline-flex min-w-0 items-center gap-0.5 hover:text-foreground"
          >
            <span className="max-w-24 truncate">
              {parties.runs.length === 1 ? "Open run" : run.agentName}
            </span>
            <ArrowUpRight className="size-3 shrink-0" aria-hidden="true" />
          </Link>
        ))}
      </span>
    </div>
  );
}

function Counts({ view, parties }: { view: RanOnView; parties: RanOnParties }) {
  const runtimeCount = (
    <span
      className="inline-flex shrink-0 items-center gap-0.5 text-indigo-700/80 dark:text-indigo-300/80"
      title={`${view.runtimeRequests} requests in Agent Runtime`}
    >
      <Container className="size-3" aria-hidden="true" />
      <span>{view.runtimeRequests}</span>
    </span>
  );
  const dot = (
    <span aria-hidden="true" className="text-muted-foreground/40">
      ·
    </span>
  );
  return (
    <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap text-muted-foreground">
      {view.side === "client" ? (
        <>
          <span
            className="inline-flex shrink-0 items-center gap-0.5"
            title={`${view.clientRequests} requests in ${parties.clientLabel}`}
          >
            <Laptop className="size-3" aria-hidden="true" />
            <span>{view.clientRequests}</span>
          </span>
          {dot}
          {runtimeCount}
          {dot}
          <span className="truncate">
            {view.moves.length} {view.moves.length === 1 ? "move" : "moves"}
          </span>
          {parties.origin ? (
            <>
              {dot}
              <Link
                href={parties.origin.href}
                className="truncate underline-offset-2 hover:text-foreground hover:underline"
              >
                from {parties.origin.label}
              </Link>
            </>
          ) : null}
        </>
      ) : (
        <>
          {runtimeCount}
          {dot}
          {parties.origin ? (
            <Link
              href={parties.origin.href}
              className="truncate underline-offset-2 hover:text-foreground hover:underline"
            >
              from {parties.origin.label}
            </Link>
          ) : (
            <span className="truncate">from {parties.clientLabel}</span>
          )}
        </>
      )}
    </span>
  );
}

function SegmentBar({
  segment,
  parties,
  runs,
}: {
  segment: RanOnSegment;
  parties: RanOnParties;
  /** The runs that held a runtime stretch. */
  runs: RanOnRun[];
}) {
  // One run links to its terminal; several share the stretch.
  const run = runs.length === 1 ? runs[0] : null;
  const runtime = segment.holder === "runtime";
  const href = segment.elsewhere
    ? (parties.origin?.href ?? null)
    : runtime
      ? (run?.href ?? null)
      : null;
  const agentName =
    run?.agentName ??
    (runs.length > 1 ? `${runs.length} runs` : "Agent Runtime");
  const Icon = runtime ? Container : Laptop;
  const title = segment.elsewhere
    ? `Back in ${parties.clientLabel}`
    : runtime
      ? `Agent Runtime · ${agentName}`
      : parties.clientLabel;
  const style: CSSProperties = {
    left: `calc(${segment.x0 * 100}% + 1px)`,
    width: `max(4px, calc(${(segment.x1 - segment.x0) * 100}% - 2px))`,
  };
  const className = cn(
    "@container absolute inset-y-[7px] flex items-center justify-center gap-1 overflow-hidden rounded-[4px] px-1.5 leading-none whitespace-nowrap outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring/60",
    segment.elsewhere
      ? SEGMENT_STYLE.elsewhere
      : runtime
        ? SEGMENT_STYLE.runtime
        : SEGMENT_STYLE.client,
  );
  const ariaLabel = `${title}, ${formatElapsed(segment.end - segment.start)}`;
  const body = (
    <>
      <Icon
        className="hidden size-3 shrink-0 @[30px]:block"
        aria-hidden="true"
      />
      <span
        className={cn(
          "hidden truncate font-medium @[72px]:inline",
          segment.elsewhere && "rounded-sm bg-card px-1 py-0.5",
        )}
      >
        {segment.elsewhere
          ? parties.clientLabel
          : runtime
            ? "Agent Runtime"
            : parties.clientLabel}
      </span>
      {runtime ? (
        <span className="hidden truncate opacity-70 @[180px]:inline">
          {agentName}
        </span>
      ) : null}
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {href ? (
          <Link
            href={href}
            aria-label={ariaLabel}
            className={className}
            style={style}
          >
            {body}
          </Link>
        ) : (
          <UnstyledButton
            aria-label={ariaLabel}
            className={cn(className, "cursor-default")}
            style={style}
          >
            {body}
          </UnstyledButton>
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-64 px-3 py-2">
        <div className="flex items-center gap-1.5 font-medium">
          <Icon
            className={cn(
              "size-3.5 shrink-0",
              runtime && "text-indigo-600 dark:text-indigo-300",
            )}
            aria-hidden="true"
          />
          <span>{title}</span>
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular-nums">
          {segment.elsewhere ? null : (
            <>
              <dt className="text-muted-foreground">Requests</dt>
              <dd>{segment.requests}</dd>
              <dt className="text-muted-foreground">Cost</dt>
              <dd>
                {segment.subscription
                  ? "Subscription"
                  : formatUsageCost(segment.billed)}
              </dd>
            </>
          )}
          <dt className="text-muted-foreground">Duration</dt>
          <dd>{formatElapsed(Math.max(0, segment.end - segment.start))}</dd>
          <dt className="text-muted-foreground">Time</dt>
          <dd>
            {clock(segment.start)}–{clock(segment.end)}
          </dd>
        </dl>
        {href ? (
          <p className="mt-1.5 text-muted-foreground">
            {segment.elsewhere
              ? `Its requests are in the ${parties.clientLabel} session. Click to open it.`
              : "Click to open the run's terminal."}
          </p>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

function MoveKnob({
  move,
  parties,
  run,
}: {
  move: RanOnMove;
  parties: RanOnParties;
  run: RanOnRun | null;
}) {
  const agentName = run?.agentName ?? "Agent Runtime";
  const Icon = move.kind === "pull" ? ArrowDownLeft : ArrowUpRight;
  const copy: Record<RanOnMove["kind"], ReactNode> = {
    push: `Handed to ${agentName}`,
    pull: `Taken back to ${parties.clientLabel}`,
    steer: `Sent back to ${agentName}`,
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`${copy[move.kind]} at ${clock(move.at)}`}
          className={cn(
            WIDE_ONLY,
            "absolute top-1/2 z-10 size-4 -translate-x-1/2 -translate-y-1/2 cursor-default items-center justify-center rounded-full border bg-card text-foreground/70 shadow-xs outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
          )}
          style={{ left: `${move.x * 100}%` }}
        >
          <Icon className="size-2.5" aria-hidden="true" />
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="tabular-nums">
        <span>{copy[move.kind]}</span>
        <span className="text-muted-foreground"> · {clock(move.at)}</span>
      </TooltipContent>
    </Tooltip>
  );
}

function runOf(parties: RanOnParties, runId: string | null): RanOnRun | null {
  return parties.runs.find((run) => run.runId === runId) ?? null;
}

function clock(ms: number): string {
  return formatDate({
    date: new Date(ms).toISOString(),
    dateFormat: "HH:mm:ss",
  });
}
