"use client";

import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleX,
  FileCode2,
  History,
  Info,
  Maximize2,
  Minimize2,
  RotateCcw,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import type { PolicyTestRun } from "@/lib/openappa-policy-tests.query";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";

// ===========================================================================
// Docked panel: an editor-style integrated panel pinned to the bottom of the
// content section, with OUTPUT / PROBLEMS tabs. The page above stays
// usable: the panel only covers its own height and the page gets matching
// bottom padding so everything can scroll clear of it.
// ===========================================================================

export type RunnerFileStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "cannot_run";

export type RunnerFile = {
  path: string;
  /** Human name from the file's first comment line. */
  name: string;
  status: RunnerFileStatus;
  steps: PolicyTestRun["files"][number]["steps"];
  /** How many of `steps` are shown so far. */
  revealedSteps: number;
  assertionCount: number;
  error: string | null;
  /** Wall time so far (running) or in total (finished); null while queued. */
  durationMs: number | null;
  /** True when the file waited on a model (slow); drawn as a hint. */
  slow: boolean;
};

export type RunnerCounts = Record<RunnerFileStatus, number> & {
  total: number;
};

/**
 * `mode: "live"` follows a run as it happens; `mode: "replay"` shows a
 * recorded run from history. `run` is null while a live run is still going.
 */
type RunnerViewProps = {
  open: boolean;
  onClose: () => void;
  mode: "live" | "replay";
  run: PolicyTestRun | null;
  /** Why the run ended without a recorded run. */
  error?: string | null;
  /** When the run started (ISO). */
  startedAt: string;
  files: RunnerFile[];
  counts: RunnerCounts;
  done: boolean;
  elapsedMs: number | null;
  onRunAgain: () => void;
  canRunAgain: boolean;
  onOpenFile: (path: string) => void;
  onOpenHistory: () => void;
};

type SimFile = RunnerFile;

/** A live run that ended before it was recorded: only its error is known. */
type RunnerRunError = {
  executionError: string;
  validation: { errors: string[]; warnings: string[] };
};

type RunInfo = PolicyTestRun | RunnerRunError;

function recordedRun(run: RunInfo | null) {
  return run && "createdAt" in run ? run : null;
}

export function ValidationRunnerPanel({
  open,
  onClose,
  mode,
  run: recorded,
  error,
  files,
  counts,
  done,
  elapsedMs,
  startedAt,
  onRunAgain,
  canRunAgain,
  onOpenFile,
  onOpenHistory,
}: RunnerViewProps) {
  const rect = useContentRect();
  // A run that failed before it was recorded still reads as one with an error.
  const run = useMemo(
    () =>
      recorded ??
      (error
        ? ({
            executionError: error,
            validation: { errors: [], warnings: [] },
          } satisfies RunnerRunError)
        : null),
    [recorded, error],
  );
  const reduceMotion = usePrefersReducedMotion();
  const [tab, setTab] = useState<Tab>("output");
  const [size, setSize] = useState<PanelSize>("normal");
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [dragging, setDragging] = useState(false);
  const [seenProblemsAt, setSeenProblemsAt] = useState(-1);
  const panelRef = useRef<HTMLElement>(null);

  // Size the panel to the viewport once it is known.
  useEffect(() => {
    const phone = window.innerWidth < 640;
    setHeight(
      clamp(
        Math.round(window.innerHeight * (phone ? 0.58 : 0.44)),
        260,
        phone ? 560 : 480,
      ),
    );
  }, []);

  const groups = useMemo(() => buildProblems(run, files), [run, files]);
  const problemCount = groups.reduce(
    (n, g) => n + g.problems.filter((p) => p.severity !== "info").length,
    0,
  );
  const finished = counts.passed + counts.failed + counts.cannot_run;
  const outcome: Outcome = run?.executionError
    ? "error"
    : !done
      ? "run"
      : counts.failed + counts.cannot_run > 0
        ? "fail"
        : "pass";

  // Ask for attention once the run lands with problems, until PROBLEMS is opened.
  const attention =
    done && problemCount > 0 && tab !== "problems" && seenProblemsAt !== 1;
  useEffect(() => {
    if (tab === "problems" && done) setSeenProblemsAt(1);
  }, [tab, done]);
  useEffect(() => {
    if (!done) setSeenProblemsAt(-1);
  }, [done]);

  const maxHeight = rect?.height ?? 800;
  const panelHeight =
    size === "min"
      ? TAB_BAR_HEIGHT
      : size === "max"
        ? maxHeight
        : Math.min(height, maxHeight - 64);

  // Pad the page by the panel's height so content scrolls clear of it.
  useEffect(() => {
    if (!open) return;
    const el =
      document.querySelector<HTMLElement>("[data-page-scroll-container]") ??
      document.querySelector<HTMLElement>("main");
    if (!el) return;
    const previous = el.style.paddingBottom;
    el.style.paddingBottom = `${size === "max" ? 0 : panelHeight}px`;
    return () => {
      el.style.paddingBottom = previous;
    };
  }, [open, panelHeight, size]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const target = event.target as HTMLElement | null;
      const typing =
        target?.closest("input, textarea, select, [contenteditable=true]") &&
        !panelRef.current?.contains(target);
      if (typing) return;
      if (size === "max") setSize("normal");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, size]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = panelHeight;
    setDragging(true);
    const onMove = (e: PointerEvent) => {
      const next = clamp(startHeight + (startY - e.clientY), 140, maxHeight);
      setHeight(next);
      setSize(next >= maxHeight - 8 ? "max" : "normal");
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const selectTab = (next: Tab) => {
    setTab(next);
    if (size === "min") setSize("normal");
  };

  const style: CSSProperties = {
    left: rect?.left ?? 0,
    width: rect?.width ?? "100%",
    bottom: 0,
    height: panelHeight,
    transform: open ? "translateY(0)" : "translateY(calc(100% + 12px))",
    transition: reduceMotion
      ? "none"
      : [
          open
            ? `transform 460ms ${SHEET_EASE}`
            : "transform 220ms cubic-bezier(0.4, 0, 1, 1)",
          dragging ? null : `height 280ms ${SHEET_EASE}`,
        ]
          .filter(Boolean)
          .join(", "),
  };

  return (
    <section
      ref={panelRef}
      aria-label="Validation run panel"
      aria-hidden={!open}
      className={cn(
        "fixed z-40 flex flex-col border-t border-terminal-edge bg-terminal text-terminal-foreground",
        "shadow-[0_-12px_32px_-16px_rgba(0,0,0,0.35)]",
        dragging && "select-none",
      )}
      style={style}
    >
      <style>{KEYFRAMES}</style>

      {/* Resize sash, like an editor's panel border. */}
      {/* biome-ignore lint/a11y/useSemanticElements: draggable sash */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize panel"
        aria-valuenow={Math.round(panelHeight)}
        aria-valuemin={TAB_BAR_HEIGHT}
        aria-valuemax={Math.round(maxHeight)}
        tabIndex={-1}
        onPointerDown={startResize}
        onDoubleClick={() => setSize((s) => (s === "max" ? "normal" : "max"))}
        className="group absolute inset-x-0 -top-[3px] z-10 h-[7px] cursor-row-resize"
      >
        <div
          className={cn(
            "mx-auto mt-[3px] h-px w-full bg-primary opacity-0 transition-opacity delay-150 duration-150 group-hover:opacity-100",
            dragging && "opacity-100 delay-0",
          )}
        />
      </div>

      <TabBar
        tab={tab}
        onSelect={selectTab}
        problemCount={problemCount}
        problemsLive={!done && problemCount > 0}
        attention={attention}
        attentionKey={`${done}`}
        status={
          <PanelStatus
            mode={mode}
            run={run}
            counts={counts}
            outcome={outcome}
            finished={finished}
            elapsedMs={elapsedMs}
          />
        }
        actions={
          <>
            <IconAction
              label="Run all again"
              className="hidden sm:inline-flex"
              disabled={!done || !canRunAgain}
              onClick={() => {
                setTab("output");
                onRunAgain();
              }}
            >
              <RotateCcw />
            </IconAction>
            <IconAction
              label="Open run history"
              className="hidden sm:inline-flex"
              onClick={onOpenHistory}
            >
              <History />
            </IconAction>
            <span
              aria-hidden
              className="mx-1 hidden h-4 w-px bg-terminal-edge sm:block"
            />
            <IconAction
              label={size === "max" ? "Restore panel size" : "Maximize panel"}
              onClick={() => setSize((s) => (s === "max" ? "normal" : "max"))}
            >
              {size === "max" ? <Minimize2 /> : <Maximize2 />}
            </IconAction>
            <IconAction
              label={size === "min" ? "Expand panel" : "Minimize panel"}
              onClick={() => setSize((s) => (s === "min" ? "normal" : "min"))}
            >
              {size === "min" ? <ChevronUp /> : <ChevronDown />}
            </IconAction>
            <IconAction label="Close panel" onClick={onClose}>
              <X />
            </IconAction>
          </>
        }
      />

      <div
        className={cn(
          "min-h-0 flex-1 transition-opacity duration-200",
          size === "min" && "pointer-events-none opacity-0",
        )}
      >
        {tab === "output" && (
          <OutputTab
            mode={mode}
            run={run}
            startedAt={startedAt}
            files={files}
            counts={counts}
            done={done}
            elapsedMs={elapsedMs}
            problemCount={problemCount}
            onOpenFile={onOpenFile}
            onShowProblems={() => selectTab("problems")}
          />
        )}
        {tab === "problems" && (
          <ProblemsTab
            groups={groups}
            done={done}
            running={counts.running + counts.queued}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </section>
  );
}

// ===========================================================================
// Chrome: tab bar, status, actions
// ===========================================================================

function TabBar({
  tab,
  onSelect,
  problemCount,
  problemsLive,
  attention,
  attentionKey,
  status,
  actions,
}: {
  tab: Tab;
  onSelect: (tab: Tab) => void;
  problemCount: number;
  problemsLive: boolean;
  attention: boolean;
  attentionKey: string;
  status: ReactNode;
  actions: ReactNode;
}) {
  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: "output", label: "Output" },
    { id: "problems", label: "Problems", badge: problemCount },
  ];
  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    const index = tabs.findIndex((t) => t.id === tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    onSelect(tabs[(index + step + tabs.length) % tabs.length].id);
  };
  return (
    <div
      className="flex shrink-0 items-center gap-2 border-b border-terminal-edge pr-1.5 pl-2 sm:pl-3"
      style={{ height: TAB_BAR_HEIGHT }}
    >
      <div
        role="tablist"
        aria-label="Run panel views"
        className="flex h-full items-stretch"
        onKeyDown={onKeyDown}
      >
        {tabs.map((t) => {
          const active = t.id === tab;
          return (
            <UnstyledButton
              key={t.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(t.id)}
              className={cn(
                "relative flex items-center gap-1.5 px-2 text-[11px] font-medium uppercase tracking-[0.08em] outline-none transition-colors sm:px-2.5",
                "focus-visible:text-foreground focus-visible:after:bg-ring",
                "after:absolute after:inset-x-2 after:bottom-0 after:h-px after:transition-colors sm:after:inset-x-2.5",
                active
                  ? "text-foreground after:bg-foreground"
                  : "text-muted-foreground after:bg-transparent hover:text-foreground",
              )}
            >
              <span>{t.label}</span>
              {t.badge !== undefined && t.badge > 0 && (
                <span
                  key={attention ? `pulse-${attentionKey}` : "still"}
                  className={cn(
                    "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[11px] leading-none font-semibold tracking-normal tabular-nums",
                    "animate-in zoom-in-50 fade-in duration-200",
                    attention || problemsLive
                      ? "bg-red-500/15 text-red-700 dark:bg-red-500/20 dark:text-red-300"
                      : "bg-terminal-selected text-terminal-foreground",
                  )}
                  style={
                    attention
                      ? { animation: "runner-attention 1.8s ease-out 3" }
                      : undefined
                  }
                >
                  {t.badge}
                </span>
              )}
            </UnstyledButton>
          );
        })}
      </div>

      <div className="ml-auto flex min-w-0 items-center">{status}</div>

      <div className="flex shrink-0 items-center">{actions}</div>
    </div>
  );
}

function PanelStatus({
  mode,
  run,
  counts,
  outcome,
  finished,
  elapsedMs,
}: {
  mode: RunnerViewProps["mode"];
  run: RunInfo | null;
  counts: RunnerViewProps["counts"];
  outcome: Outcome;
  finished: number;
  elapsedMs: number | null;
}) {
  const frame = Math.floor((elapsedMs ?? 0) / 80) % SPINNER.length;
  return (
    <div
      aria-live="polite"
      className="hidden min-w-0 items-center gap-3 text-xs text-muted-foreground sm:flex"
    >
      {mode === "replay" && recordedRun(run) && (
        <span className="hidden truncate lg:inline">
          {`${formatDate({ date: recordedRun(run)?.createdAt ?? "", dateFormat: "MMM d, HH:mm" })} · rev ${recordedRun(run)?.policyRevision}`}
        </span>
      )}
      {outcome === "run" ? (
        <span className="flex items-center gap-1.5 text-terminal-foreground">
          <span className="w-3 text-center font-mono text-sky-600 dark:text-sky-400">
            {SPINNER[frame]}
          </span>
          <span className="tabular-nums">{`Running ${finished}/${counts.total}`}</span>
        </span>
      ) : (
        <span className="flex items-center gap-2.5 tabular-nums">
          <StatusCount tone="pass" value={counts.passed} label="passed" />
          {counts.failed > 0 && (
            <StatusCount tone="fail" value={counts.failed} label="failed" />
          )}
          {counts.cannot_run > 0 && (
            <StatusCount
              tone="warn"
              value={counts.cannot_run}
              label="cannot run"
            />
          )}
        </span>
      )}
      <span className="w-11 text-right font-mono tabular-nums">
        {elapsedLabel(elapsedMs)}
      </span>
    </div>
  );
}

function StatusCount({
  tone,
  value,
  label,
}: {
  tone: Tone;
  value: number;
  label: string;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-1.5 rounded-full", toneDot[tone])} />
      <span className="text-terminal-foreground">{value}</span>
      <span>{label}</span>
    </span>
  );
}

function IconAction({
  label,
  onClick,
  children,
  className,
  disabled,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "text-muted-foreground hover:bg-terminal-selected hover:text-foreground dark:hover:bg-terminal-selected [&_svg]:size-3.5",
        className,
      )}
    >
      {children}
    </Button>
  );
}

// ===========================================================================
// OUTPUT: the streaming reporter
// ===========================================================================

function OutputTab({
  mode,
  run,
  startedAt,
  files,
  counts,
  done,
  elapsedMs,
  problemCount,
  onOpenFile,
  onShowProblems,
}: {
  mode: RunnerViewProps["mode"];
  run: RunInfo | null;
  startedAt: string;
  files: SimFile[];
  counts: RunnerViewProps["counts"];
  done: boolean;
  elapsedMs: number | null;
  problemCount: number;
  onOpenFile: (path: string) => void;
  onShowProblems: () => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const started = files.filter((f) => f.status !== "queued");
  const finished = counts.passed + counts.failed + counts.cannot_run;
  const frame = Math.floor((elapsedMs ?? 0) / 80) % SPINNER.length;

  const streamKey = `${started.length}:${started.reduce((n, f) => n + f.revealedSteps, 0)}:${done}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follow output as it grows
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [streamKey]);
  useEffect(() => {
    if (!done) stickToBottom.current = true;
  }, [done]);

  return (
    <div
      ref={scrollRef}
      role="tabpanel"
      aria-label="Output"
      onScroll={(event) => {
        const el = event.currentTarget;
        stickToBottom.current =
          el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
      className="h-full animate-in overflow-y-auto overscroll-contain px-3 py-3 font-mono text-[12.5px] leading-[1.7] fade-in duration-200 sm:px-4"
    >
      <Banner mode={mode} run={run} done={done} fileCount={files.length} />

      {(run?.validation.errors ?? []).map((error) => (
        <Line key={error} className={toneText.fail}>
          <Glyph>✗</Glyph>
          <span className="min-w-0 break-words">{error}</span>
        </Line>
      ))}
      {(run?.validation.warnings ?? []).map((warning) => (
        <Line key={warning} className={toneText.warn}>
          <Glyph>!</Glyph>
          <span className="min-w-0 break-words">{warning}</span>
        </Line>
      ))}
      {run?.executionError && (
        <Line className="mt-1">
          <Tag tone="warn">ERROR</Tag>
          <span className={cn("min-w-0 break-words", toneText.warn)}>
            {digest(run.executionError).headline}
          </span>
        </Line>
      )}

      <div className="mt-1">
        {started.map((file, index) => (
          <FileLine
            key={file.path}
            file={file}
            frame={frame}
            delayMs={mode === "replay" && done ? index * 35 : 0}
            onOpenFile={onOpenFile}
          />
        ))}
        {!done && counts.queued > 0 && (
          <Line className="text-muted-foreground/70">
            <Glyph>·</Glyph>
            <span>{`${counts.queued} queued`}</span>
          </Line>
        )}
        {!done && (
          <span
            aria-hidden
            className="ml-[1.35rem] inline-block h-[1.05em] w-[0.55em] translate-y-[0.2em] animate-pulse bg-terminal-foreground/70"
          />
        )}
      </div>

      {(done || finished > 0) && (
        <OutputSummary
          files={files}
          counts={counts}
          done={done}
          elapsedMs={elapsedMs}
          createdAt={startedAt}
        />
      )}

      {done && (
        <div className="mt-3 animate-in fade-in slide-in-from-bottom-1 duration-300">
          {problemCount > 0 ? (
            <UnstyledButton
              onClick={onShowProblems}
              className="group flex items-baseline gap-2 text-left outline-none"
            >
              <Glyph className={toneText.fail}>❯</Glyph>
              <span className="text-terminal-foreground underline-offset-4 group-hover:underline group-focus-visible:underline">
                {`${plural(problemCount, "problem")} — open the Problems tab`}
              </span>
            </UnstyledButton>
          ) : (
            <Line className={toneText.pass}>
              <Glyph>❯</Glyph>
              <span>All validations match the current policy.</span>
            </Line>
          )}
        </div>
      )}
    </div>
  );
}

function Banner({
  mode,
  run,
  done,
  fileCount,
}: {
  mode: RunnerViewProps["mode"];
  run: RunInfo | null;
  done: boolean;
  fileCount: number;
}) {
  const recorded = recordedRun(run);
  if (!recorded)
    return (
      <div className="mb-2 animate-in fade-in duration-500">
        <Line>
          <Tag tone="run">RUN</Tag>
          <span className="min-w-0 break-words text-muted-foreground">
            {`replaying ${plural(fileCount, "validation")} against the current policy`}
          </span>
        </Line>
      </div>
    );
  const facts = [
    `policy rev ${recorded.policyRevision}`,
    triggerLabel(recorded.trigger),
    recorded.source === "github" ? "from GitHub" : "local",
    recorded.partial ? "single file" : null,
    recorded.draft ? "draft" : null,
  ].filter(Boolean);
  return (
    <div className="mb-2 animate-in fade-in duration-500">
      <Line>
        <Tag tone={mode === "replay" ? "muted" : "run"}>
          {mode === "replay" ? "REPLAY" : "RUN"}
        </Tag>
        <span className="min-w-0 break-words text-muted-foreground">
          {mode === "replay" && (
            <span className="text-foreground">
              {`${formatDate({ date: recorded.createdAt, dateFormat: "MMM d, yyyy HH:mm:ss" })}  `}
            </span>
          )}
          <span>{facts.join(" · ")}</span>
          {mode === "replay" && !done && (
            <span className={toneText.run}>{"  re-running…"}</span>
          )}
        </span>
      </Line>
      <Line className="text-muted-foreground/70">
        <Glyph />
        <span className="min-w-0 truncate">{`engine ${recorded.engineVersion} · policy ${recorded.policyHash.slice(0, 7)}`}</span>
      </Line>
    </div>
  );
}

function FileLine({
  file,
  frame,
  delayMs,
  onOpenFile,
}: {
  file: SimFile;
  frame: number;
  delayMs: number;
  onOpenFile: (path: string) => void;
}) {
  const running = file.status === "running";
  const failedStep = file.steps.find((s) => s.status !== "passed");
  const duration = file.durationMs ?? 0;
  const basename = file.path.split("/").pop();
  const showName = file.name && file.name !== basename;
  const ended = file.status === "failed" || file.status === "cannot_run";
  return (
    <div
      className="animate-in fade-in slide-in-from-left-1 fill-mode-both duration-300"
      style={{ animationDelay: `${delayMs}ms` }}
    >
      <Line>
        <Glyph className={running ? toneText.run : statusTone(file.status)}>
          {running
            ? SPINNER[frame]
            : file.status === "passed"
              ? "✓"
              : file.status === "failed"
                ? "✗"
                : "○"}
        </Glyph>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5">
          <FilePath
            path={file.path}
            onOpenFile={onOpenFile}
            className="text-foreground"
          />
          <span className="text-muted-foreground">
            {running ? (
              // Replay reports a file only once it finishes, so a running
              // file has no step count yet.
              <span>replaying…</span>
            ) : file.status === "cannot_run" ? (
              <span className={toneText.warn}>cannot run</span>
            ) : (
              <span>{plural(file.assertionCount, "assertion")}</span>
            )}
          </span>
          <span
            className={cn(
              "tabular-nums",
              duration > SLOW_MS ? toneText.warn : "text-muted-foreground",
            )}
          >
            {file.durationMs === null ? "" : `${Math.round(duration)}ms`}
          </span>
          {showName && (
            <span className="hidden min-w-0 max-w-[30rem] truncate font-sans text-[12px] text-muted-foreground/80 lg:inline">
              {file.name}
            </span>
          )}
        </span>
      </Line>

      {running && (
        <div className="ml-[0.4rem] border-l border-terminal-edge pl-[0.85rem]">
          {file.steps.slice(0, file.revealedSteps).map((step) => (
            <div
              key={`${step.line}:${step.tool}`}
              className="flex min-w-0 animate-in gap-2 text-muted-foreground fade-in duration-200"
            >
              <span
                className={
                  step.status === "passed" ? toneText.pass : toneText.fail
                }
              >
                {step.status === "passed" ? "✓" : "✗"}
              </span>
              <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground/70">
                {step.line}
              </span>
              <span className="min-w-0 truncate">{step.tool}</span>
              <span className="hidden shrink-0 text-muted-foreground/70 sm:inline">
                {`→ ${step.actual ?? "—"}`}
              </span>
            </div>
          ))}
          {file.slow && (
            <div className="flex animate-in items-center gap-2 text-muted-foreground italic fade-in duration-500">
              <span className="relative flex size-1.5">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-violet-400/60" />
                <span className="relative inline-flex size-1.5 rounded-full bg-violet-500 dark:bg-violet-400" />
              </span>
              <span>asking annotator model…</span>
            </div>
          )}
        </div>
      )}

      {ended && failedStep && (
        <div className="ml-[0.4rem] flex min-w-0 animate-in gap-2 border-l border-red-500/30 pl-[0.85rem] fade-in duration-300">
          <span className="shrink-0 text-muted-foreground/70">{`line ${failedStep.line}`}</span>
          <span className="min-w-0 truncate text-muted-foreground">
            {failedStep.tool}
          </span>
          <span className="hidden shrink-0 sm:inline">
            <span className="text-muted-foreground/70">{"expected "}</span>
            <span className="text-foreground">{failedStep.expected}</span>
            <span className="text-muted-foreground/70">{", got "}</span>
            <span className={toneText.fail}>
              {failedStep.actual ?? "no decision"}
            </span>
          </span>
        </div>
      )}
    </div>
  );
}

function OutputSummary({
  files,
  counts,
  done,
  elapsedMs,
  createdAt,
}: {
  files: SimFile[];
  counts: RunnerViewProps["counts"];
  done: boolean;
  elapsedMs: number | null;
  createdAt: string;
}) {
  const a = assertionTotals(files);
  const pending = counts.queued + counts.running;
  return (
    <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 border-t border-terminal-edge pt-3">
      <SummaryLabel>Validations</SummaryLabel>
      <SummaryParts
        total={counts.total}
        bold
        parts={[
          { value: counts.passed, label: "passed", tone: "pass" },
          { value: counts.failed, label: "failed", tone: "fail" },
          { value: counts.cannot_run, label: "cannot run", tone: "warn" },
          { value: pending, label: "pending", tone: "muted" },
        ]}
      />
      <SummaryLabel>Assertions</SummaryLabel>
      <SummaryParts
        total={a.total}
        parts={[
          { value: a.passed, label: "passed", tone: "pass" },
          { value: a.failed, label: "failed", tone: "fail" },
          { value: a.notReached, label: "not reached", tone: "muted" },
        ]}
      />
      <SummaryLabel>Start at</SummaryLabel>
      <span>{formatDate({ date: createdAt, dateFormat: "HH:mm:ss" })}</span>
      <SummaryLabel>Duration</SummaryLabel>
      <span className="tabular-nums">
        <span className="text-foreground">{elapsedLabel(elapsedMs)}</span>
        {!done && <span className={toneText.run}>{"  running"}</span>}
      </span>
    </div>
  );
}

function SummaryParts({
  parts,
  total,
  bold = false,
}: {
  parts: { value: number; label: string; tone: Tone }[];
  total: number;
  bold?: boolean;
}) {
  const shown = parts.filter((p, i) => i === 0 || p.value > 0);
  return (
    <span className="min-w-0 break-words">
      {shown.map((part, i) => (
        <span key={part.label}>
          {i > 0 && <span className="text-muted-foreground/60">{" | "}</span>}
          <span
            className={cn(
              part.value > 0 ? toneText[part.tone] : "text-muted-foreground",
              bold &&
                part.value > 0 &&
                part.tone !== "muted" &&
                "font-semibold",
            )}
          >
            {`${part.value} ${part.label}`}
          </span>
        </span>
      ))}
      <span className="text-muted-foreground">{` (${total})`}</span>
    </span>
  );
}

function SummaryLabel({ children }: { children: ReactNode }) {
  return <span className="text-right text-muted-foreground">{children}</span>;
}

// ===========================================================================
// PROBLEMS: failures as a clean, grouped list
// ===========================================================================

function ProblemsTab({
  groups,
  done,
  running,
  onOpenFile,
}: {
  groups: ProblemGroup[];
  done: boolean;
  running: number;
  onOpenFile: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  if (groups.length === 0) {
    return (
      <div
        role="tabpanel"
        aria-label="Problems"
        className="flex h-full animate-in items-start px-4 py-3 text-[13px] text-muted-foreground fade-in duration-200"
      >
        <span>
          {done
            ? "No problems were found in this run."
            : `No problems so far · ${plural(running, "validation")} still to run`}
        </span>
      </div>
    );
  }
  return (
    <div
      role="tabpanel"
      aria-label="Problems"
      className="h-full animate-in overflow-y-auto overscroll-contain py-1.5 text-[13px] fade-in duration-200"
    >
      {groups.map((group) => {
        const isCollapsed = collapsed[group.key] ?? false;
        const count = group.problems.filter(
          (p) => p.severity !== "info",
        ).length;
        return (
          <div
            key={group.key}
            className="animate-in fade-in slide-in-from-bottom-1 duration-300"
          >
            <UnstyledButton
              onClick={() =>
                setCollapsed((c) => ({ ...c, [group.key]: !isCollapsed }))
              }
              aria-expanded={!isCollapsed}
              className="flex h-7 w-full min-w-0 items-center gap-1.5 px-2 text-left outline-none hover:bg-terminal-selected/60 focus-visible:bg-terminal-selected sm:px-3"
            >
              <ChevronRight
                className={cn(
                  "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150",
                  !isCollapsed && "rotate-90",
                )}
              />
              <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="shrink-0 truncate font-medium text-foreground sm:max-w-[60%]">
                {group.title}
              </span>
              {group.subtitle && (
                <span className="hidden min-w-0 truncate font-mono text-xs text-muted-foreground sm:inline">
                  {group.subtitle}
                </span>
              )}
              <span className="ml-auto inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-terminal-selected px-1 text-[11px] leading-none font-medium tabular-nums text-terminal-foreground">
                {count}
              </span>
            </UnstyledButton>
            {!isCollapsed &&
              group.problems.map((problem) => (
                <ProblemRow
                  key={problem.key}
                  problem={problem}
                  onOpen={
                    group.path
                      ? () => onOpenFile(group.path as string)
                      : undefined
                  }
                />
              ))}
          </div>
        );
      })}
      {!done && (
        <div className="flex items-center gap-2 px-3 pt-2 pl-[2.1rem] text-xs text-muted-foreground sm:pl-[2.6rem]">
          <span className="relative flex size-1.5">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sky-400/60" />
            <span className="relative inline-flex size-1.5 rounded-full bg-sky-500" />
          </span>
          <span>{`${plural(running, "validation")} still running`}</span>
        </div>
      )}
    </div>
  );
}

function ProblemRow({
  problem,
  onOpen,
}: {
  problem: Problem;
  onOpen?: () => void;
}) {
  const icon =
    problem.severity === "error" ? (
      <CircleX className="size-3.5 text-red-600 dark:text-red-400" />
    ) : problem.severity === "warning" ? (
      <AlertTriangle className="size-3.5 text-yellow-700 dark:text-yellow-300" />
    ) : (
      <Info className="size-3.5 text-muted-foreground" />
    );
  const body = (
    <>
      <span className="mt-[3px] shrink-0">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span
            className={cn(
              "min-w-0",
              problem.severity === "info"
                ? "text-muted-foreground"
                : "text-foreground",
            )}
          >
            {problem.message}
          </span>
          {problem.source && (
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
              {problem.source}
            </span>
          )}
        </span>
        {problem.reasons.map((reason) => (
          <span key={reason} className="text-muted-foreground">
            {reason}
          </span>
        ))}
      </span>
      {problem.line !== undefined && (
        <span className="mt-px shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {`line ${problem.line}`}
        </span>
      )}
    </>
  );
  const rowClass =
    "flex w-full min-w-0 items-start gap-2 py-1 pr-3 pl-[2.1rem] text-left sm:pr-4 sm:pl-[2.6rem]";
  return (
    <div className="group/row">
      {onOpen && problem.severity !== "info" ? (
        <UnstyledButton
          onClick={onOpen}
          title="Open validation"
          className={cn(
            rowClass,
            "outline-none hover:bg-terminal-selected/60 focus-visible:bg-terminal-selected",
          )}
        >
          {body}
        </UnstyledButton>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
      {problem.engineOutput && (
        <details className="group/details pr-3 pb-1 pl-[3.45rem] sm:pl-[3.95rem]">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 transition-transform group-open/details:rotate-90" />
            <span>Engine output for agents</span>
          </summary>
          <pre className="mt-1.5 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-terminal-edge bg-terminal-elevated p-2.5 font-mono text-[11.5px] leading-relaxed text-muted-foreground">
            {problem.engineOutput}
          </pre>
        </details>
      )}
    </div>
  );
}

// ===========================================================================
// Terminal primitives
// ===========================================================================

function Line({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 items-baseline gap-2", className)}>
      {children}
    </div>
  );
}

function Glyph({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("w-3.5 shrink-0 text-center", className)}>
      {children}
    </span>
  );
}

/** Reporter-style inverse status chip (` RUN `, ` REPLAY `, ` ERROR `). */
function Tag({ tone, children }: { tone: Tone | "run"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "shrink-0 rounded-[3px] px-1.5 font-mono text-[11px] font-bold leading-[1.6] tracking-wide",
        tone === "run" &&
          "bg-sky-500 text-white dark:bg-sky-400 dark:text-sky-950",
        tone === "pass" &&
          "bg-green-600 text-white dark:bg-green-500 dark:text-green-950",
        tone === "fail" && "bg-red-600 text-white dark:bg-red-500",
        tone === "warn" && "bg-yellow-400 text-yellow-950",
        tone === "muted" && "bg-terminal-selected text-foreground",
      )}
    >
      {children}
    </span>
  );
}

function FilePath({
  path,
  onOpenFile,
  className,
}: {
  path: string;
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  const slash = path.lastIndexOf("/");
  return (
    <UnstyledButton
      onClick={() => onOpenFile(path)}
      title={`Open ${path}`}
      className={cn(
        "min-w-0 break-all text-left decoration-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:underline",
        className,
      )}
    >
      <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>
      <span>{path.slice(slash + 1)}</span>
    </UnstyledButton>
  );
}

// ===========================================================================
// Helpers
// ===========================================================================

type Tab = "output" | "problems";
type PanelSize = "normal" | "max" | "min";
type Tone = "pass" | "fail" | "warn" | "muted";
type Outcome = "run" | "pass" | "fail" | "error";
type Problem = {
  key: string;
  severity: "error" | "warning" | "info";
  message: string;
  reasons: string[];
  source?: string;
  line?: number;
  engineOutput?: string;
};
type ProblemGroup = {
  key: string;
  title: string;
  subtitle?: string;
  path?: string;
  problems: Problem[];
};

function buildProblems(run: RunInfo | null, files: SimFile[]): ProblemGroup[] {
  const groups: ProblemGroup[] = [];
  const runProblems: Problem[] = [
    ...(run?.validation.errors ?? []).map(
      (error, i): Problem => ({
        key: `ve-${i}`,
        severity: "error",
        message: error,
        reasons: [],
      }),
    ),
    ...(run?.validation.warnings ?? []).map(
      (warning, i): Problem => ({
        key: `vw-${i}`,
        severity: "warning",
        message: warning,
        reasons: [],
      }),
    ),
  ];
  if (run?.executionError) {
    const why = digest(run.executionError);
    runProblems.push({
      key: "exec",
      severity: "warning",
      message: why.headline,
      reasons: why.reasons,
      engineOutput: why.rest ? run.executionError : undefined,
    });
  }
  if (runProblems.length)
    groups.push({
      key: "run",
      title: "This run",
      subtitle: recordedRun(run)
        ? `policy rev ${recordedRun(run)?.policyRevision}`
        : undefined,
      problems: runProblems,
    });

  for (const file of files) {
    if (file.status !== "failed" && file.status !== "cannot_run") continue;
    const step = file.steps.find((s) => s.status !== "passed");
    const raw = step?.error ?? file.error ?? "";
    const why = withStepReasons(raw ? digest(raw) : null, step?.reasons);
    const problems: Problem[] = [];
    if (step && step.status === "failed") {
      problems.push({
        key: "step",
        severity: "error",
        message: `Expected ${step.expected}, received ${step.actual ?? "no decision"}`,
        reasons: why ? (why.reasons.length ? why.reasons : [why.headline]) : [],
        source: step.tool,
        line: step.line,
        engineOutput: raw || undefined,
      });
    } else {
      problems.push({
        key: "cannot",
        severity: file.status === "failed" ? "error" : "warning",
        message: why?.headline ?? "Could not run this validation",
        reasons: why?.reasons ?? [],
        source: step?.tool,
        line: step?.line,
        engineOutput: why?.rest ? raw : undefined,
      });
    }
    const notReached = Math.max(0, file.assertionCount - file.steps.length);
    if (notReached > 0)
      problems.push({
        key: "skipped",
        severity: "info",
        message: `${plural(notReached, "later assertion")} not reached — replay stops at the first failure`,
        reasons: [],
      });
    groups.push({
      key: file.path,
      title: file.name || file.path,
      subtitle: file.path,
      path: file.path,
      problems,
    });
  }
  return groups;
}

/**
 * The engine's failure text is written for agents. Pull out the human part —
 * the headline and the `Why:` bullets — and keep the rest for a disclosure.
 */
function digest(raw: string) {
  const lines = raw.split("\n");
  let headline = "";
  const reasons: string[] = [];
  let section: "lead" | "why" = "lead";
  let restStart = -1;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    if (/^why:?$/i.test(text)) {
      section = "why";
      continue;
    }
    if (/^[A-Z][\w -]*:$/.test(text) && !/^\s/.test(lines[i])) {
      restStart = i;
      break;
    }
    if (!headline && section === "lead") {
      headline = text.replace(/^\[appa\]\s*/i, "");
      continue;
    }
    if (section === "why") {
      const bullet = /^[-*•]\s+(.*)$/.exec(text);
      if (bullet) reasons.push(capitalize(bullet[1]));
      else if (reasons.length) reasons[reasons.length - 1] += ` ${text}`;
      else reasons.push(capitalize(text));
    } else if (restStart < 0) {
      restStart = i;
      break;
    }
  }
  const rest = restStart >= 0 ? lines.slice(restStart).join("\n").trim() : "";
  return { headline: headline || raw.trim(), reasons, rest };
}

function assertionTotals(files: SimFile[]) {
  const finished = files.filter(
    (f) => f.status !== "queued" && f.status !== "running",
  );
  return {
    passed: finished.reduce(
      (n, f) => n + f.steps.filter((s) => s.status === "passed").length,
      0,
    ),
    failed: finished.reduce(
      (n, f) => n + f.steps.filter((s) => s.status !== "passed").length,
      0,
    ),
    notReached: finished.reduce(
      (n, f) => n + Math.max(0, f.assertionCount - f.steps.length),
      0,
    ),
    total: files.reduce((n, f) => n + f.assertionCount, 0),
  };
}

function statusToTone(status: SimFile["status"]): Tone {
  return status === "passed"
    ? "pass"
    : status === "failed"
      ? "fail"
      : status === "cannot_run"
        ? "warn"
        : "muted";
}

function statusTone(status: SimFile["status"]) {
  return toneText[statusToTone(status)];
}

function triggerLabel(trigger: PolicyTestRun["trigger"]) {
  return trigger === "policy_change"
    ? "policy change"
    : trigger === "github_sync"
      ? "GitHub sync"
      : "manual";
}

function capitalize(s: string) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Runs recorded before durations were stored have no elapsed time. */
function elapsedLabel(elapsedMs: number | null) {
  return elapsedMs === null ? "—" : formatSeconds(elapsedMs);
}

function formatSeconds(ms: number) {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function clamp(n: number, min: number, max: number) {
  return Math.min(Math.max(n, min), Math.max(min, max));
}

function usePrefersReducedMotion() {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduce(query.matches);
    const onChange = () => setReduce(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return reduce;
}

const toneText: Record<Tone | "run", string> = {
  pass: "text-green-700 dark:text-green-400",
  fail: "text-red-600 dark:text-red-400",
  warn: "text-yellow-700 dark:text-yellow-300",
  muted: "text-muted-foreground",
  run: "text-sky-600 dark:text-sky-400",
};
const toneDot: Record<Tone, string> = {
  pass: "bg-green-500",
  fail: "bg-red-500",
  warn: "bg-yellow-400",
  muted: "bg-muted-foreground/50",
};

const KEYFRAMES = `
@keyframes runner-attention {
  0% { box-shadow: 0 0 0 0 rgb(239 68 68 / 0.55); }
  70% { box-shadow: 0 0 0 6px rgb(239 68 68 / 0); }
  100% { box-shadow: 0 0 0 0 rgb(239 68 68 / 0); }
}`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SLOW_MS = 2500;
const TAB_BAR_HEIGHT = 36;
const DEFAULT_HEIGHT = 380;
const SHEET_EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** The page's content section (right of the sidebar), tracked live. */
function useContentRect() {
  const [rect, setRect] = useState<{
    left: number;
    width: number;
    top: number;
    height: number;
  } | null>(null);
  useEffect(() => {
    const main = document.querySelector("main");
    if (!main) return;
    const update = () => {
      const r = main.getBoundingClientRect();
      setRect({ left: r.left, width: r.width, top: r.top, height: r.height });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(main);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);
  return rect;
}

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
