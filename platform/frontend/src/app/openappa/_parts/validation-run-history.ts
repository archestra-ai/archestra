export type ValidationRunStatus = "passed" | "failed" | "cannot_run";

/** The fields of a recorded run that its outcome and chart column read. */
type RecordedRun = {
  id: string;
  createdAt: string;
  executionError?: string | null;
  validation: { valid: boolean };
  files: { status: ValidationRunStatus }[];
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
