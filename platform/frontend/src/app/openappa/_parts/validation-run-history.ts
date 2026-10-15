export type ValidationRunStatus = "passed" | "failed" | "cannot_run";

/** The fields of a recorded run that its outcome, chart column and file states read. */
type RecordedRun = {
  id: string;
  createdAt: string;
  executionError?: string | null;
  validation: { valid: boolean };
  files: {
    path: string;
    contentHash: string;
    status: ValidationRunStatus;
    error?: string | null;
  }[];
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

/** A current validation file, with the SHA-256 hex of its content as runs record it. */
type CurrentFile = { path: string; contentHash: string };

export type ValidationFileState = {
  status: ValidationRunStatus | "not_run";
  /** When the run that replayed this exact content was recorded. */
  runAt: string | null;
  error: string | null;
};

/**
 * Each file's result from the newest run that replayed its current content.
 * A run of an older version of the file, or of a file since deleted, says
 * nothing about it: such a file is not run.
 */
export function validationFileStates(
  files: CurrentFile[],
  runs: RecordedRun[],
): Map<string, ValidationFileState> {
  return new Map(
    files.map((file): [string, ValidationFileState] => {
      for (const run of runs) {
        const result = run.files.find(
          (item) =>
            item.path === file.path && item.contentHash === file.contentHash,
        );
        // A refused policy or a failed run decided nothing about the file.
        if (result)
          return [
            file.path,
            {
              status:
                run.executionError || !run.validation.valid
                  ? "cannot_run"
                  : result.status,
              runAt: run.createdAt,
              error: result.error || run.executionError || null,
            },
          ];
      }
      return [file.path, { status: "not_run", runAt: null, error: null }];
    }),
  );
}

/**
 * The newest run, when it replayed exactly the current files or failed before
 * replaying any; otherwise none, because its counts would describe files that
 * changed or no longer exist.
 */
export function currentValidationRun<Run extends RecordedRun>(
  files: CurrentFile[],
  runs: Run[],
): Run | null {
  const latest = runs[0];
  if (latest?.executionError && !latest.files.length) return latest;
  if (!latest || !files.length) return null;
  const covers = files.every((file) =>
    latest.files.some(
      (item) =>
        item.path === file.path && item.contentHash === file.contentHash,
    ),
  );
  return covers && latest.files.length === files.length ? latest : null;
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

/** The SHA-256 hex of a file's content, the hash the backend records per run file. */
export async function validationContentHash(content: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
