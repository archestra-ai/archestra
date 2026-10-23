export type ValidationRunStatus = "passed" | "failed" | "cannot_run";

/** The fields of a recorded run that its outcome, chart column and file states read. */
type RecordedRun = {
  id: string;
  createdAt: string;
  executionError?: string | null;
  trigger?: "manual" | "github_sync" | "policy_change";
  partial?: boolean;
  validation: { valid: boolean; errors?: string[] };
  files: {
    path: string;
    contentHash: string;
    status: ValidationRunStatus;
    error?: string | null;
    steps?: RecordedStep[];
  }[];
};

type RecordedStep = {
  line: number;
  tool: string;
  expected: string;
  actual: string | null;
  status: ValidationRunStatus;
  error?: string | null;
  /** Why a blocked call was blocked; runs recorded before it have none. */
  reasons?: string[];
};

/** One run's outcome: any failure fails it; anything unreplayed means it cannot run. */
export function validationRunStatus(run: RecordedRun): ValidationRunStatus {
  if (run.executionError || !run.validation.valid || !run.files.length)
    return "cannot_run";
  if (run.files.some((file) => file.status === "failed")) return "failed";
  if (run.files.some((file) => file.status === "cannot_run"))
    return "cannot_run";
  return "passed";
}

export type ValidationRunBar = {
  id: string;
  createdAt: string;
  passed: number;
  failed: number;
  cannotRun: number;
  total: number;
};

/**
 * Runs as chart columns, oldest first, so time reads left to right. A run that
 * could not start has no file counts; it keeps one "cannot run" unit so it is
 * still visible.
 */
export function validationRunBars(runs: RecordedRun[]): ValidationRunBar[] {
  return runs
    .map((run) => {
      const count = (status: ValidationRunStatus) =>
        run.files.filter((file) => file.status === status).length;
      const passed = count("passed");
      const failed = count("failed");
      const cannotRun = Math.max(
        count("cannot_run"),
        passed + failed === 0 ? 1 : 0,
      );
      return {
        id: run.id,
        createdAt: run.createdAt,
        passed,
        failed,
        cannotRun,
        total: passed + failed + cannotRun,
      };
    })
    .reverse();
}

/** A current validation file. */
type CurrentFile = { path: string };

export type ValidationFileState = {
  status: ValidationRunStatus | "not_run";
  /** When the run that last replayed this file was recorded. */
  runAt: string | null;
  /** What kind of run recorded the result, e.g. "Single file run". */
  runLabel: string | null;
  error: string | null;
  /** The step whose decision did not match, when that is what failed the file. */
  failedStep: RecordedStep | null;
};

/** The kind of run, as run history names it. */
export function validationRunLabel(
  run: Pick<RecordedRun, "trigger" | "partial">,
) {
  if (run.partial) return "Single file run";
  if (run.trigger === "github_sync") return "Git sync run";
  if (run.trigger === "policy_change") return "Policy change run";
  return "Manual run";
}

/**
 * The newest run that replayed this file, with its result for it. An edit
 * does not clear it: the file keeps its last result until it runs again.
 */
export function latestFileResult<Run extends RecordedRun>(
  file: CurrentFile,
  runs: Run[],
): { run: Run; result: Run["files"][number] } | null {
  for (const run of runs) {
    const result = run.files.find((item) => item.path === file.path);
    if (result) return { run, result };
  }
  return null;
}

/** Each file's result from the newest run that replayed it; never run, not run. */
export function validationFileStates(
  files: CurrentFile[],
  runs: RecordedRun[],
): Map<string, ValidationFileState> {
  return new Map(
    files.map((file): [string, ValidationFileState] => {
      const latest = latestFileResult(file, runs);
      if (latest) {
        const { run, result } = latest;
        // A refused policy or a failed run decided nothing about the file.
        const runError = [
          result.error || run.executionError,
          ...(run.validation.valid ? [] : (run.validation.errors ?? [])),
        ]
          .filter(Boolean)
          .join("\n");
        const step = result.steps?.find((item) => item.status !== "passed");
        return [
          file.path,
          {
            status:
              run.executionError || !run.validation.valid
                ? "cannot_run"
                : result.status,
            runAt: run.createdAt,
            runLabel: validationRunLabel(run),
            error: runError || (step ? stepSummary(step) : null),
            failedStep: runError ? null : mismatchedStep(result.steps),
          },
        ];
      }
      return [
        file.path,
        {
          status: "not_run",
          runAt: null,
          runLabel: null,
          error: null,
          failedStep: null,
        },
      ];
    }),
  );
}

/**
 * The first step that did not pass, in a few lines: what was expected, what
 * came instead and why. A blocked call's full feedback speaks to the agent
 * (remedies, delegation advice), so it stays out unless replay could not
 * decide the step at all.
 */
function stepSummary(step: RecordedStep) {
  const at = `Line ${step.line} · ${step.tool}`;
  if (step.status === "cannot_run" && step.error) return `${at}: ${step.error}`;
  return [
    `${at}: expected ${step.expected}, got ${step.actual ?? "no decision"}`,
    ...(step.reasons ?? []),
  ].join("\n");
}

/** The step a file failed on, when a decision that did not match failed it. */
export function mismatchedStep<Step extends RecordedStep>(
  steps: Step[] | undefined,
): Step | null {
  const step = steps?.find((item) => item.status !== "passed");
  return step?.status === "failed" ? step : null;
}

export type ValidationSuiteSummary = {
  status: ValidationRunStatus | "not_run";
  passed: number;
  total: number;
  notRun: number;
  /** The newest run behind any current result. */
  runAt: string;
  /** Set when that run failed before replaying any file. */
  error: string | null;
};

/**
 * The current files' results added up, each from the newest run that replayed
 * it, so it always agrees with the per-file statuses. A newer run that failed
 * before replaying any file (say, the Git source was unreadable) overrides
 * them: it is what happened last. Null when no current file has a result.
 */
export function validationSuiteSummary(
  files: CurrentFile[],
  runs: RecordedRun[],
): ValidationSuiteSummary | null {
  const states = [...validationFileStates(files, runs).values()];
  const runAt = states
    .map((state) => state.runAt)
    .filter((at): at is string => at !== null)
    .sort()
    .at(-1);
  const latest = runs[0];
  if (
    latest?.executionError &&
    !latest.files.length &&
    (!runAt || latest.createdAt > runAt)
  )
    return {
      status: "cannot_run",
      passed: 0,
      total: files.length,
      notRun: files.length,
      runAt: latest.createdAt,
      error: latest.executionError,
    };
  if (!runAt) return null;
  const count = (status: ValidationFileState["status"]) =>
    states.filter((state) => state.status === status).length;
  const status = count("failed")
    ? "failed"
    : count("cannot_run")
      ? "cannot_run"
      : count("not_run")
        ? "not_run"
        : "passed";
  return {
    status,
    passed: count("passed"),
    total: files.length,
    notRun: count("not_run"),
    runAt,
    error: null,
  };
}

/** "2 of 3 passed · 1 not run", or why the last run could not start. */
export function validationSummaryText(summary: ValidationSuiteSummary) {
  if (summary.error) return "Cannot run";
  const replayed = summary.total - summary.notRun;
  return `${summary.passed} of ${replayed} passed${summary.notRun ? ` · ${summary.notRun} not run` : ""}`;
}

/** The name the file's author gave it: its first `#` comment line, else its file name. */
export function validationName(file: { path: string; content: string }) {
  for (const line of file.content.split("\n")) {
    const text = line.trim();
    if (!text) continue;
    const comment = /^#\s*(.+)$/.exec(text);
    if (comment) return comment[1].trim();
    break;
  }
  return file.path.split("/").pop() || file.path;
}
