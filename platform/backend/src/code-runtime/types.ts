export const CODE_RUNTIME_LIMITS = {
  maxCpuSeconds: 30,
  maxCodeBytes: 64 * 1024,
  maxMemoryBytes: 1024 * 1024 * 1024,
  maxProcesses: 128,
  maxQueueLength: 50,
  maxRequirements: 20,
  maxRequirementBytes: 200,
} as const;

export interface RunCodeParams {
  /** python source to execute. */
  code: string;
  /** caller-requested wall-clock cap in seconds; clamped to the configured maximum. */
  timeoutSeconds?: number;
  /** python package requirements passed to `uv run --with`. */
  requirements?: string[];
}

export interface RunCodeResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  /** the script was killed by the wall-clock timeout. */
  timedOut: boolean;
  /** stdout or stderr was truncated to the configured byte cap. */
  truncated: boolean;
}

/**
 * raised when a run cannot be performed at all — runtime disabled, engine
 * unreachable, or the run hung past its backstop. a script that runs and exits
 * non-zero is a successful {@link RunCodeResult}, not an error.
 */
export class CodeRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodeRuntimeError";
  }
}
