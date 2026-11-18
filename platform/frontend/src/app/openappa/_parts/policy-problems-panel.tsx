"use client";

import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FlaskConical,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { UnstyledButton } from "@/components/ui/unstyled-button";
import { formatDate } from "@/lib/utils/date-time";
import { cn } from "@/lib/utils/tailwind";
import { POLICY_FILE_KIND } from "./policy-file-kind";
import type { ValidationSuite } from "./validation-context";
import {
  latestFileResult,
  validationRunLabel,
  validationSuiteSummary,
  validationSummaryText,
} from "./validation-run-history";

/** One thing a validation's last run got wrong, with the line it is on. */
export type ValidationProblem = {
  id: string;
  path: string;
  line: number;
  kind: "failed" | "cannot_run";
  /** A failed step: the tool, and what was expected and decided. */
  step?: {
    tool: string;
    expected: string;
    actual: string | null;
    reasons?: string[];
  };
  /** Why a file or a step could not run. */
  message?: string;
};

/**
 * Every current validation's problems, each from the newest run that
 * replayed its file: a step that decided otherwise, or what kept it from
 * running.
 */
export function validationProblems(
  suite: ValidationSuite,
): ValidationProblem[] {
  const runs = suite.history.data ?? [];
  return suite.files.flatMap((file): ValidationProblem[] => {
    const latest = latestFileResult(file, runs);
    if (!latest) return [];
    const { run, result } = latest;
    const steps = (result.steps ?? []).flatMap((step): ValidationProblem[] =>
      step.status === "failed"
        ? [
            {
              id: `${file.path}:${step.line}`,
              path: file.path,
              line: step.line,
              kind: "failed",
              step,
            },
          ]
        : step.status === "cannot_run" && step.error
          ? [
              {
                id: `${file.path}:${step.line}`,
                path: file.path,
                line: step.line,
                kind: "cannot_run",
                message: step.error,
              },
            ]
          : [],
    );
    if (steps.length > 0 || result.status === "passed") return steps;
    return [
      {
        id: `${file.path}:file`,
        path: file.path,
        line: 1,
        kind: result.status === "failed" ? "failed" : "cannot_run",
        message:
          result.error ||
          run.executionError ||
          (run.validation.valid ? null : run.validation.errors?.[0]) ||
          "This file did not run.",
      },
    ];
  });
}

/**
 * The validations' problems under the editor, as an IDE lists them: grouped
 * by file, each opening its line. Folded, one line says how the last run
 * went. The run's output opens beside the list.
 */
export function PolicyProblemsPanel({
  suite,
  problems,
  open,
  onOpenChange,
  activeId,
  onPick,
  onOpenFile,
  onStep,
}: {
  suite: ValidationSuite;
  problems: ValidationProblem[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeId: string | undefined;
  onPick: (problem: ValidationProblem) => void;
  onOpenFile: (path: string) => void;
  onStep: (direction: 1 | -1) => void;
}) {
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [showOutput, setShowOutput] = useState(false);
  const drag = useRef<{ y: number; height: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { y: event.clientY, height };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    const next = drag.current.height + drag.current.y - event.clientY;
    setHeight(Math.min(460, Math.max(96, next)));
  };

  const runs = suite.history.data ?? [];
  const summary = useMemo(
    () => validationSuiteSummary(suite.files, runs),
    [suite.files, runs],
  );
  const groups = useMemo(() => {
    const byPath = new Map<string, ValidationProblem[]>();
    for (const problem of problems)
      byPath.set(problem.path, [...(byPath.get(problem.path) ?? []), problem]);
    return [...byPath].map(([path, items]) => ({ path, items }));
  }, [problems]);
  const failed = new Set(
    problems.filter((item) => item.kind === "failed").map((item) => item.path),
  ).size;
  const cannotRun = new Set(
    problems
      .filter((item) => item.kind === "cannot_run")
      .map((item) => item.path),
  ).size;
  const quiet = problems.length === 0;
  const runningLabel = suite.runningAll
    ? `Running ${suite.files.length} validation${suite.files.length === 1 ? "" : "s"}…`
    : suite.runningPath
      ? `Running ${baseName(suite.runningPath)}…`
      : null;
  const latestRun = suite.currentRun;
  const output = useMemo(
    () => (latestRun ? runOutput(latestRun) : []),
    [latestRun],
  );

  return (
    <section
      aria-label="Validation problems"
      className="relative flex shrink-0 flex-col border-t bg-background"
      style={open ? { height } : undefined}
    >
      {open && (
        // A drag handle; the panel also folds from its header and with Cmd/Ctrl+J.
        <div
          aria-hidden
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => {
            drag.current = null;
          }}
          onDoubleClick={() => setHeight(DEFAULT_HEIGHT)}
          className="absolute inset-x-0 -top-[3px] z-20 h-[6px] cursor-row-resize transition-colors hover:bg-primary/40 active:bg-primary/60"
        />
      )}
      <div
        className={cn(
          "flex h-7 shrink-0 items-center gap-2 pr-1 text-xs",
          open && "border-b bg-muted/40",
        )}
      >
        <UnstyledButton
          aria-expanded={open}
          aria-label={open ? "Hide problems" : "Show problems"}
          onClick={() => onOpenChange(!open)}
          className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-left outline-none hover:bg-accent/40 focus-visible:bg-accent/40"
        >
          <ChevronRight
            className={cn(
              "size-3 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
            aria-hidden
          />
          {open && (
            <span className="flex shrink-0 items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-muted-foreground">
              <span>Problems</span>
              <span
                className={cn(
                  "rounded-full px-1.5 font-mono text-[10px] font-medium leading-4 tabular-nums",
                  quiet || runningLabel
                    ? "bg-muted text-muted-foreground"
                    : "bg-destructive/10 text-destructive",
                )}
              >
                {runningLabel ? "…" : problems.length}
              </span>
            </span>
          )}
          {runningLabel ? (
            <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
              <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden />
              <span className="truncate">{runningLabel}</span>
            </span>
          ) : !summary ? (
            <span className="text-muted-foreground">
              {suite.files.length
                ? "No validation has run yet"
                : "No validations yet"}
            </span>
          ) : quiet ? (
            <span className="flex items-center gap-1.5 text-muted-foreground">
              <Check className="size-3 text-emerald-500" aria-hidden />
              <span>No problems</span>
            </span>
          ) : (
            !open && (
              <span className="flex shrink-0 items-center gap-1.5 font-medium">
                {failed > 0 && (
                  <span className="flex items-center gap-1 text-destructive">
                    <X className="size-3" aria-hidden />
                    <span>{`${failed} failed`}</span>
                  </span>
                )}
                {failed > 0 && cannotRun > 0 && (
                  <span className="text-muted-foreground">·</span>
                )}
                {cannotRun > 0 && (
                  <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                    <TriangleAlert className="size-3" aria-hidden />
                    <span>{`${cannotRun} cannot run`}</span>
                  </span>
                )}
              </span>
            )
          )}
          {!runningLabel && summary && (
            <span className="ml-auto hidden min-w-0 truncate pr-1 text-[11px] tabular-nums text-muted-foreground sm:inline">
              {[
                validationSummaryText(summary),
                formatDate({ date: summary.runAt, dateFormat: "MMM d, HH:mm" }),
                latestRun
                  ? `policy revision ${latestRun.policyRevision}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          )}
        </UnstyledButton>

        {!quiet && (
          <div className="flex shrink-0 items-center">
            <PanelIcon
              label="Previous problem (⇧F8)"
              onClick={() => onStep(-1)}
            >
              <ChevronUp className="size-3.5" />
            </PanelIcon>
            <PanelIcon label="Next problem (F8)" onClick={() => onStep(1)}>
              <ChevronDown className="size-3.5" />
            </PanelIcon>
          </div>
        )}
        {open && output.length > 0 && (
          <UnstyledButton
            aria-pressed={showOutput}
            onClick={() => setShowOutput(!showOutput)}
            className={cn(
              "h-5 shrink-0 rounded-sm px-1.5 text-[11px] outline-none hover:bg-accent focus-visible:bg-accent",
              showOutput
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {showOutput ? "Hide output" : "Show output"}
          </UnstyledButton>
        )}
      </div>

      {open && (
        <div className="flex min-h-0 flex-1">
          <div
            className={cn(
              "min-w-0 flex-1 overflow-y-auto py-0.5",
              // A phone has no room for both: the output takes the panel.
              showOutput && output.length > 0 && "hidden md:block",
            )}
          >
            {quiet ? (
              <p className="px-3 py-2 text-xs text-muted-foreground">
                {!summary
                  ? suite.files.length
                    ? "Run the validations to see how the policy decides them."
                    : "A validation replays tool calls against the policy and checks each decision."
                  : summary.notRun
                    ? "Every validation that ran passed."
                    : `All ${summary.total} validations passed.`}
              </p>
            ) : (
              groups.map(({ path, items }) => {
                const slash = path.lastIndexOf("/");
                return (
                  <div key={path}>
                    <UnstyledButton
                      onClick={() => onOpenFile(path)}
                      className="flex h-6 w-full items-center gap-1.5 px-2 text-left text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent/60"
                    >
                      <FlaskConical
                        className={cn(
                          "size-3.5 shrink-0",
                          POLICY_FILE_KIND.validation.iconClass,
                        )}
                        aria-hidden
                      />
                      <span className="shrink-0 font-medium">
                        {baseName(path)}
                      </span>
                      {slash > 0 && (
                        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                          {path.slice(0, slash)}
                        </span>
                      )}
                      <span className="ml-auto shrink-0 rounded-full bg-muted px-1.5 font-mono text-[10px] leading-4 text-muted-foreground">
                        {items.length}
                      </span>
                    </UnstyledButton>
                    {items.map((problem) => (
                      <UnstyledButton
                        key={problem.id}
                        onClick={() => onPick(problem)}
                        className={cn(
                          "flex h-[26px] w-full items-center gap-1.5 pr-2 pl-7 text-left text-xs outline-none hover:bg-accent/60 focus-visible:bg-accent/60",
                          runningLabel && "opacity-50",
                          problem.id === activeId && "bg-accent",
                        )}
                      >
                        {problem.kind === "failed" ? (
                          <X
                            className="size-3.5 shrink-0 text-destructive"
                            aria-hidden
                          />
                        ) : (
                          <TriangleAlert
                            className="size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                            aria-hidden
                          />
                        )}
                        {problem.step ? (
                          <>
                            <span className="shrink-0 font-mono text-[11.5px]">
                              {problem.step.tool}
                            </span>
                            <span className="shrink-0 text-foreground/80">
                              {`expected ${problem.step.expected}, got ${problem.step.actual ?? "no decision"}`}
                            </span>
                            <span className="hidden min-w-0 truncate text-muted-foreground lg:inline">
                              {problem.step.reasons?.[0]}
                            </span>
                          </>
                        ) : (
                          <span className="min-w-0 truncate text-foreground/80">
                            {`${problem.kind === "failed" ? "Failed" : "Cannot run"}: ${problem.message}`}
                          </span>
                        )}
                        <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {`line ${problem.line}`}
                        </span>
                      </UnstyledButton>
                    ))}
                  </div>
                );
              })
            )}
          </div>
          {showOutput && output.length > 0 && (
            <ResizableOutput>
              <pre className="min-w-0 flex-1 overflow-auto bg-muted/20 px-3 py-1.5 font-mono text-[11px] leading-[18px] text-muted-foreground">
                {output.map((line, index) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: the lines of one run, in order
                    key={index}
                    className={cn(
                      "block whitespace-pre",
                      line.startsWith("✗") && "text-destructive",
                      line.startsWith("!") &&
                        "text-amber-700 dark:text-amber-400",
                      line.startsWith("    ") && "text-foreground/80",
                    )}
                  >
                    {line}
                  </span>
                ))}
              </pre>
            </ResizableOutput>
          )}
        </div>
      )}
    </section>
  );
}

// === Internal ===

type Run = NonNullable<ValidationSuite["currentRun"]>;

/** The latest run as a log: one line per file, its failures under it. */
function runOutput(run: Run): string[] {
  return [
    `${validationRunLabel(run)} · ${formatDate({ date: run.createdAt, dateFormat: "MMM d, HH:mm:ss" })} · policy revision ${run.policyRevision} · engine ${run.engineVersion}`,
    ...(run.executionError ? [`! ${run.executionError}`] : []),
    ...(run.validation.valid
      ? []
      : run.validation.errors.map((error) => `! ${error}`)),
    ...run.files.flatMap((file) => {
      const mark =
        file.status === "passed" ? "✓" : file.status === "failed" ? "✗" : "!";
      const steps = `${file.steps.length} step${file.steps.length === 1 ? "" : "s"}`;
      return [
        `${mark} ${file.path}  ${steps}${file.durationMs ? `  ${file.durationMs}ms` : ""}`,
        ...(file.error ? [`    ${file.error}`] : []),
        ...file.steps.flatMap((step) =>
          step.status === "failed"
            ? [
                `    line ${step.line}: ${step.tool} expected ${step.expected}, got ${step.actual ?? "no decision"}`,
              ]
            : step.status === "cannot_run" && step.error
              ? [`    line ${step.line}: ${step.error}`]
              : [],
        ),
      ];
    }),
  ];
}

/**
 * The run output beside the problems, as wide as its left edge is dragged. On
 * a phone it takes the panel's width in the problems' place.
 */
function ResizableOutput({ children }: { children: ReactNode }) {
  const [width, setWidth] = useState(46);
  const box = useRef<HTMLDivElement>(null);
  const clamp = (next: number) => Math.min(80, Math.max(20, next));
  return (
    <div
      ref={box}
      style={{ "--output-width": `${width}%` } as CSSProperties}
      className="relative flex w-full shrink-0 md:w-(--output-width) md:border-l"
    >
      {/* biome-ignore lint/a11y/useSemanticElements: a draggable splitter, not a thematic break */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the output"
        aria-valuenow={Math.round(width)}
        aria-valuemin={20}
        aria-valuemax={80}
        tabIndex={0}
        onPointerDown={(event) => {
          // Keeps the drag from selecting the output's text.
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          const row = box.current?.parentElement?.getBoundingClientRect();
          if (!row) return;
          setWidth(clamp(((row.right - event.clientX) / row.width) * 100));
        }}
        onDoubleClick={() => setWidth(46)}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") setWidth((value) => clamp(value + 4));
          if (event.key === "ArrowRight") setWidth((value) => clamp(value - 4));
        }}
        className="absolute inset-y-0 -left-1 z-10 hidden w-2 cursor-col-resize md:block outline-none transition-colors hover:bg-primary/30 focus-visible:bg-primary/40 active:bg-primary/50"
      />
      {children}
    </div>
  );
}

function PanelIcon({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          onClick={onClick}
          className="size-5 text-muted-foreground hover:text-foreground"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

const DEFAULT_HEIGHT = 184;
