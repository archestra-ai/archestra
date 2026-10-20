"use client";

import {
  ArrowRight,
  Check,
  FileText,
  GitBranch,
  History,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatCompactRelativeTime, formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { validationFileHref } from "./validation-context";

// ===========================================================================
// Run matrix + selection detail panel. Files are rows, runs are columns
// (newest on the right) under a policy-revision band. Hovering a cell previews
// it in the panel on the right; clicking pins it. The panel starts on the
// latest run's first failing file, so the page opens on what needs attention.
// File health tags are quiet text, not pills.
// ===========================================================================

export function ValidationRunMatrix({
  runs,
  isLoading,
  onOpenRun,
  names,
}: {
  runs: PolicyTestRun[];
  isLoading: boolean;
  /** Open one run in the runner panel. */
  onOpenRun: (runId: string) => void;
  /** path -> human name, for files in the current suite. */
  names: Record<string, string>;
}) {
  const [limit, setLimit] = useState(INITIAL_COLUMNS);
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [hovered, setHovered] = useState<CellKey | null>(null);
  const [pinned, setPinned] = useState<CellKey | null>(null);
  const grid = useMemo(
    () => buildGrid(runs, names, limit),
    [runs, names, limit],
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: re-pin when the column count changes
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [grid.columns.length]);

  if (isLoading) return <GridSkeleton />;
  if (!grid.columns.length)
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-card px-6 py-14 text-center">
        <History className="size-5 text-muted-foreground" />
        <p className="text-sm font-medium">No runs yet</p>
        <p className="max-w-xs text-sm text-muted-foreground">
          Run your validations and each run lands here as a column, newest on
          the right.
        </p>
      </div>
    );

  const latest = grid.columns.at(-1);
  const olderHidden = grid.totalRuns - grid.columns.length;
  const active =
    resolve(grid, hovered) ??
    resolve(grid, pinned) ??
    resolve(grid, grid.defaultKey);
  const activeKey = pinned ?? grid.defaultKey;
  const isPinned = (k: CellKey) =>
    activeKey !== null &&
    activeKey.runId === k.runId &&
    activeKey.path === k.path;

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Summary + legend */}
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold tracking-tight">
            Validation health
          </h2>
          {latest && (
            <p className="text-sm text-muted-foreground">
              Latest run {relative(latest.run.createdAt)} on rev{" "}
              {latest.run.policyRevision} ·{" "}
              <span
                className={cn(
                  "font-medium tabular-nums",
                  latest.run.executionError
                    ? STATUS_TEXT.cannot_run
                    : latest.failed
                      ? STATUS_TEXT.failed
                      : STATUS_TEXT.passed,
                )}
              >
                {latest.run.executionError
                  ? "could not run"
                  : `${latest.passed} of ${latest.present} passing`}
              </span>
            </p>
          )}
        </div>
        <Legend />
      </div>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        {/* ---- The grid ---- */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-xl border bg-card">
          {/* biome-ignore lint/a11y/noStaticElementInteractions: leaving the grid only clears the hover preview */}
          <div
            ref={scrollRef}
            className="overflow-x-auto overscroll-x-contain"
            onMouseLeave={() => {
              setHovered(null);
              setHoverCol(null);
            }}
          >
            <div className="w-max min-w-full">
              <div className="flex border-b">
                <div
                  className={cn(
                    LEFT,
                    "sticky left-0 z-20 flex flex-col justify-between bg-card pt-2 pb-2",
                  )}
                >
                  <div className="h-6">
                    {olderHidden > 0 && (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="-ml-2 h-6 text-muted-foreground"
                        onClick={() => setLimit((n) => n + INITIAL_COLUMNS)}
                      >
                        <span>{`← ${Math.min(INITIAL_COLUMNS, olderHidden)} older runs`}</span>
                      </Button>
                    )}
                  </div>
                  <div className="flex items-end justify-between pr-3 text-xs text-muted-foreground">
                    <span>Validation</span>
                    <span className="hidden sm:inline">Pass rate</span>
                  </div>
                </div>

                <div className="flex flex-col pt-2">
                  <RevisionBand segments={grid.segments} />
                  <div className="flex">
                    {grid.columns.map((col, c) => (
                      <ColumnHead
                        key={col.run.id}
                        col={col}
                        hovered={hoverCol === c}
                        onHover={(on) => setHoverCol(on ? c : null)}
                        onOpen={() => onOpenRun(col.run.id)}
                      />
                    ))}
                  </div>
                </div>
                <div className="w-3 shrink-0 grow" />
              </div>

              {grid.rows.map((row, r) => (
                <div
                  key={row.path}
                  className={cn(
                    "group/row flex",
                    r > 0 && "border-t border-border/50",
                  )}
                >
                  <FileLabel row={row} />
                  {grid.columns.map((col, c) => {
                    const cell = row.cells[c];
                    const key = { runId: col.run.id, path: row.path };
                    const selected = isPinned(key);
                    const status: CellStatus = col.run.executionError
                      ? "run_error"
                      : (cell.file?.status ?? "absent");
                    return (
                      <UnstyledButton
                        key={col.run.id}
                        aria-label={`${row.name}, ${formatDate({ date: col.run.createdAt })}: ${STATUS_LABEL[status]}`}
                        aria-pressed={selected}
                        onClick={() => setPinned(key)}
                        onMouseEnter={() => {
                          setHovered(key);
                          setHoverCol(c);
                        }}
                        onFocus={() => {
                          setHovered(key);
                          setHoverCol(c);
                        }}
                        onBlur={() => setHovered(null)}
                        className={cn(
                          CELL_BOX,
                          "h-12 cursor-pointer items-center outline-none transition-colors group-hover/row:bg-muted/40 focus-visible:bg-muted",
                          col.revisionChanged && BOUNDARY,
                          hoverCol === c &&
                            "bg-muted/50 group-hover/row:bg-muted",
                        )}
                      >
                        <span
                          className="inline-flex animate-in fade-in zoom-in-50 duration-300"
                          style={enterDelay(r, c)}
                        >
                          <Cell
                            status={status}
                            regression={cell.regression}
                            selected={selected}
                          />
                        </span>
                      </UnstyledButton>
                    );
                  })}
                  <div className="w-3 shrink-0 grow transition-colors group-hover/row:bg-muted/40" />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ---- Detail panel ---- */}
        <aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-[300px]">
          {active ? (
            <DetailPanel
              key={`${active.col.run.id}:${active.row.path}`}
              active={active}
              previewing={hovered !== null && !isPinned(hovered)}
              onOpenRun={onOpenRun}
            />
          ) : (
            <div className="rounded-xl border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
              Select a cell to see what happened.
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ===========================================================================
// Pieces
// ===========================================================================

function DetailPanel({
  active,
  previewing,
  onOpenRun,
}: {
  active: Active;
  previewing: boolean;
  onOpenRun: (runId: string) => void;
}) {
  const { row, col, cell } = active;
  const run = col.run;
  const file = cell.file;
  const status: CellStatus = run.executionError
    ? "run_error"
    : (file?.status ?? "absent");
  const failing = file?.steps.find((s) => s.status !== "passed");
  const why = withStepReasons(
    digest(run.executionError ?? failing?.error ?? file?.error ?? null),
    run.executionError ? undefined : failing?.reasons,
  );
  const reasons = why
    ? why.reasons.length
      ? why.reasons
      : why.headline
        ? [why.headline]
        : []
    : [];
  const syntax = parseSyntaxError(reasons[0]);
  const trigger = run.trigger ?? "manual";
  const extras = [
    run.source === "github" ? "from GitHub" : null,
    run.partial ? "single file" : null,
    run.draft ? "unsaved draft" : null,
  ].filter((x): x is string => x !== null);

  return (
    <div className="overflow-hidden rounded-xl border bg-card animate-in fade-in duration-150">
      {/* Status + file */}
      <div className="space-y-2 px-4 pt-4 pb-3.5">
        <div className="flex items-center gap-2 text-xs">
          <Cell status={status} className="size-2.5 rounded-[3px]" />
          <span
            className={cn(
              "font-medium",
              status === "absent"
                ? "text-muted-foreground"
                : STATUS_TEXT[status],
            )}
          >
            {STATUS_LABEL[status]}
          </span>
          {cell.regression && cell.previousAt && (
            <span className="text-muted-foreground">
              · regressed, passed {formatCompactRelativeTime(cell.previousAt)}
            </span>
          )}
        </div>
        <div className="min-w-0">
          <Link
            href={validationFileHref(row.path)}
            className="block text-sm leading-snug font-medium underline-offset-4 hover:underline"
          >
            {row.name}
          </Link>
          <p
            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
            title={row.path}
          >
            {row.path}
          </p>
        </div>
      </div>

      {/* Run facts */}
      <dl className="grid grid-cols-[5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t px-4 py-3 text-sm">
        <dt className="text-muted-foreground">Run</dt>
        <dd className="truncate">{formatDate({ date: run.createdAt })}</dd>
        <dt className="text-muted-foreground">Revision</dt>
        <dd className="tabular-nums">
          rev {run.policyRevision}
          {col.currentRevision && (
            <span className="text-muted-foreground"> · current</span>
          )}
        </dd>
        <dt className="text-muted-foreground">Trigger</dt>
        <dd className="min-w-0">
          {TRIGGER_LABEL[trigger]}
          {extras.length > 0 && (
            <span className="text-muted-foreground">
              {" "}
              · {extras.join(" · ")}
            </span>
          )}
        </dd>
      </dl>

      {/* What happened */}
      <div className="space-y-3 border-t px-4 py-3.5 text-sm">
        {status === "absent" && (
          <p className="text-muted-foreground">
            {run.partial
              ? "Single-file run: only one validation was replayed."
              : "This file did not exist when the run happened."}
          </p>
        )}
        {status === "passed" && file && (
          <p className="flex items-center gap-2 text-muted-foreground">
            <Check className={cn("size-3.5", STATUS_TEXT.passed)} />
            All {file.assertionCount}{" "}
            {file.assertionCount === 1 ? "assertion" : "assertions"} held.
          </p>
        )}
        {status === "run_error" && (
          <p className="text-muted-foreground">
            The run could not execute, so no file was checked.
          </p>
        )}
        {failing && (
          <div className="space-y-1.5">
            <p className="flex min-w-0 items-baseline gap-2 font-mono text-xs">
              <span className="shrink-0 text-muted-foreground">
                line {failing.line}
              </span>
              <span className="truncate" title={failing.tool}>
                {failing.tool}
              </span>
            </p>
            <p className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
              <span className="text-muted-foreground">
                expected {failing.expected}
              </span>
              <ArrowRight className="size-3 text-muted-foreground" />
              <span className={STATUS_TEXT[failing.status]}>
                got {failing.actual ?? "no decision"}
              </span>
            </p>
          </div>
        )}
        {reasons.length > 0 &&
          status !== "passed" &&
          (syntax ? (
            <SyntaxErrorBlock error={syntax} />
          ) : (
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Why</p>
              <ul className="space-y-1 text-[13px]">
                {reasons.slice(0, 3).map((reason) => (
                  <li key={reason} className="flex gap-2 leading-snug">
                    <span className="text-muted-foreground">·</span>
                    <span className="min-w-0 break-words">
                      <InlineCode text={reason} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        {file && status !== "passed" && file.assertionCount > 0 && (
          <p className="text-xs tabular-nums text-muted-foreground">
            {file.steps.length === file.assertionCount
              ? `${file.assertionCount} of ${file.assertionCount} assertions evaluated`
              : `Stopped at assertion ${file.steps.length} of ${file.assertionCount}`}
          </p>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between gap-3 border-t px-4 py-2.5">
        <span className="truncate text-xs text-muted-foreground">
          {previewing ? "Previewing · click to pin" : fileSummary(row)}
        </span>
        <Button
          size="xs"
          variant="ghost"
          className="-mr-1.5 shrink-0"
          onClick={() => onOpenRun(run.id)}
        >
          Open run
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function FileLabel({ row }: { row: GridRow }) {
  return (
    <div
      className={cn(
        LEFT,
        "sticky left-0 z-10 flex h-12 items-center gap-3 bg-card pr-3 transition-colors group-hover/row:bg-muted",
      )}
    >
      <Link
        href={validationFileHref(row.path)}
        className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          className={cn(
            "block truncate text-sm",
            row.removed && "text-muted-foreground line-through",
          )}
          title={row.name}
        >
          {row.name}
        </span>
        <span
          className="hidden truncate font-mono text-xs text-muted-foreground sm:block"
          title={row.path}
        >
          {row.path}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground sm:hidden">
          <span className={cn("tabular-nums", rateTone(row))}>
            {formatRate(row.rate)}
          </span>
          {row.tag && <span className="truncate">· {row.tag.label}</span>}
        </span>
      </Link>
      <div className="hidden w-24 shrink-0 flex-col items-end sm:flex">
        <span
          className={cn("text-sm leading-tight tabular-nums", rateTone(row))}
          title={`Passed in ${row.passedRuns} of ${row.presentRuns} runs that included it`}
        >
          {formatRate(row.rate)}
        </span>
        {row.tag && <QuietTag tag={row.tag} />}
      </div>
    </div>
  );
}

function QuietTag({ tag }: { tag: NonNullable<GridRow["tag"]> }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex max-w-full cursor-default items-center gap-1 text-xs leading-tight whitespace-nowrap text-muted-foreground">
          <span
            className={cn("size-1 shrink-0 rounded-full", TAG_DOT[tag.tone])}
          />
          {tag.label}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {tag.detail}
      </TooltipContent>
    </Tooltip>
  );
}

function ColumnHead({
  col,
  hovered,
  onHover,
  onOpen,
}: {
  col: GridColumn;
  hovered: boolean;
  onHover: (on: boolean) => void;
  onOpen: () => void;
}) {
  const run = col.run;
  const trigger = run.trigger ?? "manual";
  const Icon = run.executionError
    ? TriangleAlert
    : trigger === "policy_change"
      ? ShieldCheck
      : trigger === "github_sync"
        ? GitBranch
        : run.partial
          ? FileText
          : null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <UnstyledButton
          aria-label={`Open run from ${formatDate({ date: run.createdAt })}, policy revision ${run.policyRevision}, ${outcomeText(col)}`}
          onClick={onOpen}
          onMouseEnter={() => onHover(true)}
          onMouseLeave={() => onHover(false)}
          onFocus={() => onHover(true)}
          onBlur={() => onHover(false)}
          className={cn(
            CELL_BOX,
            "relative h-11 cursor-pointer flex-col items-center justify-end gap-1.5 pb-2 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            col.revisionChanged && BOUNDARY,
            hovered && "bg-muted/50",
          )}
        >
          <span
            className={cn(
              "whitespace-nowrap text-[11px] leading-none tabular-nums transition-colors",
              hovered ? "text-foreground" : "text-muted-foreground",
              !col.tick && !hovered && "invisible",
            )}
          >
            {col.tick ?? col.shortTime}
          </span>
          <span className="flex h-3.5 items-center">
            {Icon ? (
              <Icon
                className={cn(
                  "size-3.5",
                  run.executionError
                    ? STATUS_TEXT.cannot_run
                    : hovered
                      ? "text-foreground"
                      : "text-muted-foreground",
                )}
                strokeWidth={1.75}
              />
            ) : (
              <span
                className={cn(
                  "size-1 rounded-full transition-colors",
                  hovered ? "bg-foreground" : "bg-muted-foreground/40",
                )}
              />
            )}
          </span>
          {run.draft && (
            <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-yellow-500" />
          )}
        </UnstyledButton>
      </TooltipTrigger>
      <TooltipContent side="top" className="text-left">
        <p className="font-medium">{formatDate({ date: run.createdAt })}</p>
        <p className="text-muted-foreground">
          {TRIGGER_LABEL[trigger]} · rev {run.policyRevision} ·{" "}
          {outcomeText(col)}
        </p>
        <p className="text-muted-foreground">Click to open the run</p>
      </TooltipContent>
    </Tooltip>
  );
}

function RevisionBand({ segments }: { segments: Segment[] }) {
  return (
    <div className="flex h-6 items-center">
      {segments.map((seg) => (
        <div
          key={`${seg.revision}-${seg.start}`}
          className="flex h-full items-center gap-1.5 px-1.5"
          style={{ width: `calc(${seg.span} * ${CELL_REM}rem)` }}
          title={`Policy revision ${seg.revision} · ${seg.span} ${seg.span === 1 ? "run" : "runs"}`}
        >
          <span
            className={cn(
              "shrink-0 text-xs whitespace-nowrap tabular-nums",
              seg.current
                ? "font-medium text-foreground"
                : "text-muted-foreground",
            )}
          >
            {seg.span === 1 ? `r${seg.revision}` : `rev ${seg.revision}`}
          </span>
          <span
            className={cn(
              "h-px min-w-0 flex-1",
              seg.current ? "bg-primary/60" : "bg-border",
            )}
          />
        </div>
      ))}
    </div>
  );
}

type CellStatus =
  | PolicyTestRun["files"][number]["status"]
  | "absent"
  | "run_error";

function Cell({
  status,
  regression = false,
  selected = false,
  className,
}: {
  status: CellStatus;
  regression?: boolean;
  selected?: boolean;
  className?: string;
}) {
  const pin =
    selected &&
    "outline-[1.5px] outline-offset-[5px] outline-foreground outline-solid";
  if (status === "absent")
    return (
      <span
        className={cn(
          "block size-5 rounded-[5px] border border-dashed border-muted-foreground/30 text-muted-foreground/25",
          pin,
          className,
        )}
        style={HATCH}
      />
    );
  if (status === "run_error")
    return (
      <span
        className={cn(
          "block h-5 w-1.5 rounded-full bg-yellow-400/70 dark:bg-yellow-500/50",
          pin,
          className,
        )}
      />
    );
  return (
    <span
      className={cn(
        "block size-5 rounded-[5px] shadow-[inset_0_-1px_0_rgb(0_0_0/0.12)]",
        STATUS_FILL[status],
        regression &&
          "ring-2 ring-red-500 ring-offset-2 ring-offset-card dark:ring-red-400",
        pin,
        className,
      )}
    />
  );
}

function Legend() {
  const items: { label: string; node: ReactNode }[] = [
    { label: "Passed", node: <Cell status="passed" className="size-3" /> },
    { label: "Failed", node: <Cell status="failed" className="size-3" /> },
    {
      label: "Cannot run",
      node: <Cell status="cannot_run" className="size-3" />,
    },
    { label: "Not in run", node: <Cell status="absent" className="size-3" /> },
    {
      label: "Regressed",
      node: (
        <Cell
          status="failed"
          regression
          className="size-3 ring-[1.5px] ring-offset-[1.5px]"
        />
      ),
    },
  ];
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      {items.map((item) => (
        <li key={item.label} className="flex items-center gap-1.5">
          {item.node}
          <span>{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

function GridSkeleton() {
  return (
    <div className="space-y-4">
      <div className="flex justify-between">
        <Skeleton className="h-10 w-56" />
        <Skeleton className="h-4 w-72 self-end" />
      </div>
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="flex-1 space-y-3 rounded-xl border bg-card p-3">
          {SKELETON_ROWS.map((r) => (
            <div key={r} className="flex items-center gap-3">
              <div className="w-40 space-y-1.5 sm:w-64">
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              {SKELETON_COLUMNS.map((c) => (
                <Skeleton
                  key={c}
                  className="size-5 rounded-[5px]"
                  style={{ animationDelay: `${(r + c) * 60}ms` }}
                />
              ))}
            </div>
          ))}
        </div>
        <Skeleton className="h-80 w-full rounded-xl lg:w-[300px]" />
      </div>
    </div>
  );
}

// ===========================================================================
// Data
// ===========================================================================

type TagTone = "broken" | "blocked" | "flaky";

type CellKey = { runId: string; path: string };

type GridCell = {
  file: PolicyTestRun["files"][number] | undefined;
  /** Passed in the previous run that included this file, fails now. */
  regression: boolean;
  previousAt: string | null;
};

type GridRow = {
  path: string;
  name: string;
  removed: boolean;
  cells: GridCell[];
  passedRuns: number;
  presentRuns: number;
  rate: number | null;
  latestStatus: PolicyTestRun["files"][number]["status"] | null;
  tag: { tone: TagTone; label: string; detail: string } | null;
};

type GridColumn = {
  run: PolicyTestRun;
  passed: number;
  failed: number;
  present: number;
  revisionChanged: boolean;
  currentRevision: boolean;
  shortTime: string;
  tick: string | null;
};

type Segment = {
  revision: number;
  start: number;
  span: number;
  current: boolean;
};

type Grid = ReturnType<typeof buildGrid>;

type Active = { row: GridRow; col: GridColumn; cell: GridCell };

function resolve(grid: Grid, key: CellKey | null): Active | null {
  if (!key) return null;
  const c = grid.columns.findIndex((col) => col.run.id === key.runId);
  const row = grid.rows.find((r) => r.path === key.path);
  if (c < 0 || !row) return null;
  return { row, col: grid.columns[c], cell: row.cells[c] };
}

function buildGrid(
  runs: PolicyTestRun[],
  names: Record<string, string>,
  limit: number,
) {
  const all = [...runs].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const chrono = all.slice(Math.max(0, all.length - limit));
  const currentRev = chrono.at(-1)?.policyRevision;

  const columns: GridColumn[] = chrono.map((run, i) => {
    const shortTime = compactTime(run.createdAt);
    const prevTime = i > 0 ? compactTime(chrono[i - 1].createdAt) : null;
    return {
      run,
      passed: run.files.filter((f) => f.status === "passed").length,
      failed: run.files.filter((f) => f.status !== "passed").length,
      present: run.files.length,
      revisionChanged:
        i > 0 && chrono[i - 1].policyRevision !== run.policyRevision,
      currentRevision: run.policyRevision === currentRev,
      shortTime,
      tick:
        shortTime !== prevTime || i === chrono.length - 1 ? shortTime : null,
    };
  });

  const segments: Segment[] = [];
  chrono.forEach((run, i) => {
    const last = segments.at(-1);
    if (last && last.revision === run.policyRevision) last.span++;
    else
      segments.push({
        revision: run.policyRevision,
        start: i,
        span: 1,
        current: false,
      });
  });
  const lastSeg = segments.at(-1);
  if (lastSeg) lastSeg.current = true;

  const seen = new Set<string>();
  for (const run of chrono) for (const f of run.files) seen.add(f.path);
  const suiteOrder = Object.keys(names).filter((p) => seen.has(p));
  const extra = [...seen].filter((p) => !(p in names)).sort();
  const paths = [...suiteOrder, ...extra];
  const byRun = chrono.map(
    (run) => new Map(run.files.map((f) => [f.path, f] as const)),
  );

  const rows: GridRow[] = paths.map((path) => {
    const cells: GridCell[] = [];
    const history: {
      status: PolicyTestRun["files"][number]["status"];
      i: number;
    }[] = [];
    let flips = 0;
    for (let i = 0; i < chrono.length; i++) {
      const file = byRun[i].get(path);
      const prev = history.at(-1);
      let regression = false;
      let previousAt: string | null = null;
      if (file) {
        if (prev && prev.status !== file.status) flips++;
        if (prev?.status === "passed" && file.status === "failed") {
          regression = true;
          previousAt = chrono[prev.i].createdAt;
        }
        history.push({ status: file.status, i });
      }
      cells.push({ file, regression, previousAt });
    }
    const passedRuns = history.filter((h) => h.status === "passed").length;
    return {
      path,
      name: names[path] ?? prettyBasename(path),
      removed: !(path in names),
      cells,
      passedRuns,
      presentRuns: history.length,
      rate: history.length ? passedRuns / history.length : null,
      latestStatus: history.at(-1)?.status ?? null,
      tag: tagFor({ history, flips, chrono, removed: !(path in names) }),
    };
  });

  // Default selection: the latest run's first failing file (else its first).
  let defaultKey: CellKey | null = null;
  for (let c = columns.length - 1; c >= 0 && !defaultKey; c--) {
    const run = columns[c].run;
    if (run.executionError || !run.files.length) continue;
    const failing = rows.find(
      (r) => r.cells[c].file && r.cells[c].file?.status !== "passed",
    );
    const first = failing ?? rows.find((r) => r.cells[c].file);
    if (first) defaultKey = { runId: run.id, path: first.path };
  }

  return { columns, rows, segments, totalRuns: all.length, defaultKey };
}

function tagFor({
  history,
  flips,
  chrono,
  removed,
}: {
  history: { status: PolicyTestRun["files"][number]["status"]; i: number }[];
  flips: number;
  chrono: PolicyTestRun[];
  removed: boolean;
}): GridRow["tag"] {
  if (removed || !history.length) return null;
  const latest = history[history.length - 1];
  if (latest.status !== "passed") {
    let s = history.length - 1;
    while (s > 0 && history[s - 1].status === latest.status) s--;
    const since = chrono[history[s].i];
    const neverPassed = !history.some((h) => h.status === "passed");
    const tone: TagTone = latest.status === "failed" ? "broken" : "blocked";
    const verb = latest.status === "failed" ? "Failing" : "Cannot run";
    if (flips >= 3)
      return {
        tone: "flaky",
        label: "flaky",
        detail: `Changed result ${flips} times; ${verb.toLowerCase()} right now.`,
      };
    return {
      tone,
      label: neverPassed
        ? latest.status === "failed"
          ? "never passed"
          : "never ran"
        : `${tone === "broken" ? "failing" : "blocked"} since r${since.policyRevision}`,
      detail: neverPassed
        ? `${verb} in every recorded run.`
        : `${verb} since ${formatDate({ date: since.createdAt })} (policy revision ${since.policyRevision}).`,
    };
  }
  if (flips >= 2)
    return {
      tone: "flaky",
      label: "flaky",
      detail: `Changed result ${flips} times across ${history.length} runs.`,
    };
  return null;
}

/** Pull the human reasons out of the engine's agent-facing failure text. */
function digest(
  text: string | null | undefined,
): { headline: string; reasons: string[] } | null {
  if (!text) return null;
  const lines = text.split("\n");
  const headline = (lines.find((l) => l.trim()) ?? "")
    .replace(/^\[appa\]\s*/, "")
    .trim();
  const reasons: string[] = [];
  const start = lines.findIndex((l) => /^\s*Why:\s*$/.test(l));
  if (start >= 0) {
    for (const line of lines.slice(start + 1)) {
      const bullet = /^\s*-\s+(.*)$/.exec(line);
      if (bullet) reasons.push(bullet[1].trim());
      else if (line.trim() || reasons.length) break;
    }
  }
  return { headline, reasons };
}

function fileSummary(row: GridRow) {
  const rate = `${formatRate(row.rate)} pass rate`;
  return row.tag ? `${rate} · ${row.tag.label}` : rate;
}

function compactTime(at: string) {
  if (Date.now() - Date.parse(at) < 60_000) return "now";
  return formatCompactRelativeTime(at).replace(/ ago$/, "");
}

function relative(at: string) {
  if (Date.now() - Date.parse(at) < 60_000) return "just now";
  return formatCompactRelativeTime(at);
}

function outcomeText(col: GridColumn) {
  if (col.run.executionError) return "Could not run";
  return `${col.passed} of ${col.present} passed`;
}

function formatRate(rate: number | null) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

function rateTone(row: GridRow) {
  if (row.latestStatus === "failed") return STATUS_TEXT.failed;
  if (row.latestStatus === "cannot_run") return STATUS_TEXT.cannot_run;
  return "text-muted-foreground";
}

function prettyBasename(path: string) {
  return (path.split("/").pop() ?? path).replace(/\.appa$/, "");
}

function enterDelay(row: number, col: number): CSSProperties {
  return {
    animationDelay: `${col * 22 + row * 12}ms`,
    animationFillMode: "both",
  };
}

const INITIAL_COLUMNS = 30;
const CELL_REM = 2;
/** Fixed-width run column; width must match CELL_REM. */
const CELL_BOX = "flex w-8 shrink-0 justify-center";
/** Sticky file column. */
const LEFT =
  "w-48 shrink-0 border-r border-border/60 pl-4 sm:w-[20rem] xl:w-[22rem]";
/** Dashed divider on the first column of a new policy revision. */
const BOUNDARY = "border-l border-dashed border-primary/35";

const HATCH: CSSProperties = {
  backgroundImage:
    "repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 4px)",
};

const STATUS_FILL: Record<PolicyTestRun["files"][number]["status"], string> = {
  passed: "bg-green-500/75 dark:bg-green-500/65",
  failed: "bg-red-500 dark:bg-red-500/90",
  cannot_run: "bg-yellow-400 dark:bg-yellow-500/80",
};

const STATUS_TEXT: Record<Exclude<CellStatus, "absent">, string> = {
  passed: "text-green-700 dark:text-green-400",
  failed: "text-red-700 dark:text-red-400",
  cannot_run: "text-yellow-800 dark:text-yellow-300",
  run_error: "text-yellow-800 dark:text-yellow-300",
};

const STATUS_LABEL: Record<CellStatus, string> = {
  passed: "Passed",
  failed: "Failed",
  cannot_run: "Cannot run",
  absent: "Not in this run",
  run_error: "Run could not execute",
};

const TRIGGER_LABEL: Record<NonNullable<PolicyTestRun["trigger"]>, string> = {
  manual: "Manual",
  policy_change: "Policy save",
  github_sync: "GitHub sync",
};

const TAG_DOT: Record<TagTone, string> = {
  broken: "bg-red-500/80",
  blocked: "bg-yellow-500/80",
  flaky: "bg-yellow-500/80",
};

// ===========================================================================
// Syntax errors: the engine's one-line message, laid out like an editor
// diagnostic instead of a sentence full of backticks.
// ===========================================================================

type AppaSyntaxError = {
  path: string;
  line: number;
  expected: string[];
  found: string | null;
  afterLine: number | null;
  message: string;
};

function parseSyntaxError(text: string | undefined): AppaSyntaxError | null {
  const match = text
    ? /^(\S+\.appa):(\d+):\s*([\s\S]+)$/.exec(text.trim())
    : null;
  if (!match) return null;
  const message = match[3];
  const shape =
    /^expected ([\s\S]+?)(?: after the call at line (\d+))?, found `([^`]*)`$/.exec(
      message,
    );
  return {
    path: match[1],
    line: Number(match[2]),
    expected: shape
      ? Array.from(shape[1].matchAll(/`([^`]+)`/g), (m) => m[1])
      : [],
    found: shape ? shape[3] : null,
    afterLine: shape?.[2] ? Number(shape[2]) : null,
    message,
  };
}

function SyntaxErrorBlock({ error }: { error: AppaSyntaxError }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        Syntax error · line {error.line}
      </p>
      <div className="overflow-hidden rounded-md border bg-muted/40 font-mono text-[11px] leading-relaxed">
        <div className="flex items-center gap-2 border-b px-2.5 py-1 text-muted-foreground">
          <span className="truncate">{error.path}</span>
          <span className="ml-auto shrink-0 tabular-nums">:{error.line}</span>
        </div>
        <div className="space-y-1 px-2.5 py-2">
          {error.expected.length > 0 ? (
            <>
              {error.found !== null && (
                <p>
                  <span className="text-muted-foreground">found </span>
                  <span className="text-red-700 dark:text-red-400">
                    {error.found || "end of file"}
                  </span>
                </p>
              )}
              <p className="text-muted-foreground">
                expected
                {error.afterLine !== null &&
                  ` after the call at line ${error.afterLine}`}
              </p>
              <ul className="space-y-0.5 pl-2">
                {error.expected.map((item) => (
                  <li key={item} className="text-green-700 dark:text-green-400">
                    {item}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="whitespace-pre-wrap break-words">
              <InlineCode text={error.message} />
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Renders `backticked` spans as code. */
function InlineCode({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((part, index) =>
        part.startsWith("`") && part.endsWith("`") && part.length > 1 ? (
          <code
            // biome-ignore lint/suspicious/noArrayIndexKey: static split of one string
            key={index}
            className="rounded bg-muted px-1 py-px font-mono text-[0.85em]"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

const SKELETON_ROWS = Array.from({ length: 8 }, (_, index) => index);
const SKELETON_COLUMNS = Array.from({ length: 10 }, (_, index) => index);

/**
 * Prefer the reasons replay recorded for a blocked step; runs recorded before
 * replay kept them have only the engine's text to read them from.
 */
function withStepReasons<T extends { reasons: string[] }>(
  why: T | null,
  reasons: string[] | undefined,
): T | null {
  return why && reasons?.length
    ? { ...why, reasons: reasons.map(capitalize) }
    : why;
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
