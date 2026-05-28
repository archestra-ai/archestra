import {
  checkSession,
  type ReplayCommand,
  readArtifact,
  runSandbox,
  type SnapshotFile,
} from "@archestra/sandbox-rs";
import {
  context as otelContext,
  propagation as otelPropagation,
} from "@opentelemetry/api";
import config from "@/config";
import logger from "@/logging";

export type DaggerRuntimeStatus =
  | "disabled"
  | "initializing"
  | "ready"
  | "error"
  | "stopped";

export class DaggerRuntimeError extends Error {
  readonly code: NativeSandboxErrorCode;
  constructor(
    message: string,
    code: NativeSandboxErrorCode = "ARCHESTRA_INTERNAL",
  ) {
    super(message);
    this.name = "DaggerRuntimeError";
    this.code = code;
  }
}

type NativeSandboxErrorCode =
  | "ARCHESTRA_ARTIFACT_NOT_FOUND"
  | "ARCHESTRA_ARTIFACT_TOO_LARGE"
  | "ARCHESTRA_ENGINE_UNREACHABLE"
  | "ARCHESTRA_INTERNAL"
  | "ARCHESTRA_INVALID_INPUT";

export interface RunCommandParams {
  command: string;
  cwd: string;
  timeoutSeconds: number;
  snapshots?: SnapshotFile[];
  replayCommands?: ReplayCommand[];
  /** override the default per-call output cap. */
  outputBytesLimit?: number;
  /** override the per-call artifact size cap. */
  fileSizeLimitBytes?: number;
  /** ad-hoc apt packages installed on top of the warm base. usually empty. */
  extraAptPackages?: string[];
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

export interface ReadArtifactParams {
  path: string;
  snapshots?: SnapshotFile[];
  replayCommands?: ReplayCommand[];
  fileSizeLimitBytes?: number;
  extraAptPackages?: string[];
}

export interface ReadArtifactResult {
  dataBase64: string;
  sizeBytes: number;
}

/**
 * Process-singleton Dagger runtime — every shell command (skill sandbox or
 * python script) flows through this service. The native side keeps one
 * long-lived Dagger session with a pre-warmed base container, so per-call
 * overhead is dominated by the command itself rather than session/image setup.
 */
class DaggerRuntimeService {
  private status: DaggerRuntimeStatus = "disabled";
  private initPromise: Promise<void> | null = null;
  private lastInitAttemptAt = 0;
  private activeRuns = 0;
  private readonly waiters: Array<() => void> = [];

  get isEnabled(): boolean {
    return config.daggerRuntime.enabled;
  }

  get isReady(): boolean {
    return this.status === "ready";
  }

  async init(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      this.status = "disabled";
      return;
    }
    if (this.status === "ready" || this.status === "stopped") return;
    if (this.initPromise) return this.initPromise;

    const now = Date.now();
    if (
      this.status === "error" &&
      now - this.lastInitAttemptAt < INIT_RETRY_COOLDOWN_MS
    ) {
      return;
    }

    this.initPromise = this.doInit().finally(() => {
      this.initPromise = null;
    });
    return this.initPromise;
  }

  async runCommand(params: RunCommandParams): Promise<RunCommandResult> {
    await this.ensureReady();
    await this.acquire();
    try {
      const result = await runSandbox({
        traceparent: getTraceparent(),
        snapshots: params.snapshots ?? [],
        replayCommands: params.replayCommands ?? [],
        limits: this.limits({
          outputBytesLimit: params.outputBytesLimit,
          fileSizeLimitBytes: params.fileSizeLimitBytes,
        }),
        command: params.command,
        cwd: params.cwd,
        timeoutSeconds: params.timeoutSeconds,
        extraAptPackages: params.extraAptPackages ?? [],
      });
      return result;
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.release();
    }
  }

  async readArtifact(params: ReadArtifactParams): Promise<ReadArtifactResult> {
    await this.ensureReady();
    await this.acquire();
    try {
      const result = await readArtifact({
        traceparent: getTraceparent(),
        snapshots: params.snapshots ?? [],
        replayCommands: params.replayCommands ?? [],
        limits: this.limits({
          fileSizeLimitBytes: params.fileSizeLimitBytes,
        }),
        path: params.path,
        extraAptPackages: params.extraAptPackages ?? [],
      });
      return result;
    } catch (error) {
      throw this.normalizeError(error);
    } finally {
      this.release();
    }
  }

  async shutdown(): Promise<void> {
    if (this.status !== "disabled") {
      this.status = "stopped";
    }
  }

  // === private ===

  private async ensureReady(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      throw new DaggerRuntimeError(
        "the Dagger runtime is not enabled",
        "ARCHESTRA_INVALID_INPUT",
      );
    }
    await this.init();
    switch (this.status) {
      case "stopped":
        throw new DaggerRuntimeError(
          "the Dagger runtime has been stopped",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
      case "ready":
        return;
      default:
        throw new DaggerRuntimeError(
          "the Dagger runtime is not available (engine unreachable)",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
    }
  }

  private async doInit(): Promise<void> {
    if (!config.daggerRuntime.enabled) {
      this.status = "disabled";
      return;
    }
    this.applyDaggerEnv();
    this.lastInitAttemptAt = Date.now();
    this.status = "initializing";

    try {
      await checkSession({ traceparent: getTraceparent() });
      this.status = "ready";
      logger.info("[DaggerRuntime] ready — shared session + warm base online");
    } catch (error) {
      this.status = "error";
      logger.error(
        { err: error },
        "[DaggerRuntime] failed to initialize — sandbox execution unavailable",
      );
    }
  }

  private applyDaggerEnv(): void {
    const { runnerHost, cliBin } = config.daggerRuntime;
    if (runnerHost) {
      process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST = runnerHost;
    }
    if (cliBin) {
      process.env._EXPERIMENTAL_DAGGER_CLI_BIN = cliBin;
    }
  }

  private limits(overrides?: {
    outputBytesLimit?: number;
    fileSizeLimitBytes?: number;
  }) {
    const { defaults } = config.daggerRuntime;
    return {
      outputBytesLimit:
        overrides?.outputBytesLimit ?? defaults.outputBytesLimit,
      fileSizeLimitBytes:
        overrides?.fileSizeLimitBytes ?? defaults.fileSizeLimitBytes,
      cpuSeconds: defaults.cpuSeconds,
      memoryBytes: defaults.memoryBytes,
      maxProcesses: defaults.maxProcesses,
    };
  }

  private async acquire(): Promise<void> {
    if (this.activeRuns < config.daggerRuntime.maxConcurrent) {
      this.activeRuns++;
      return;
    }
    if (this.waiters.length >= config.daggerRuntime.maxQueueLength) {
      throw new DaggerRuntimeError(
        "the Dagger runtime is at capacity — too many runs are already queued",
        "ARCHESTRA_ENGINE_UNREACHABLE",
      );
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
    } else {
      this.activeRuns--;
    }
  }

  private normalizeError(error: unknown): DaggerRuntimeError {
    if (error instanceof DaggerRuntimeError) return error;
    const native = getNativeSandboxError(error);
    switch (native.code) {
      case "ARCHESTRA_ARTIFACT_NOT_FOUND":
      case "ARCHESTRA_ARTIFACT_TOO_LARGE":
      case "ARCHESTRA_INVALID_INPUT":
        return new DaggerRuntimeError(native.message, native.code);
      case "ARCHESTRA_ENGINE_UNREACHABLE":
      case "ARCHESTRA_INTERNAL":
      case null:
        this.status = "error";
        logger.error(
          { err: error, code: native.code },
          "[DaggerRuntime] execution failed",
        );
        return new DaggerRuntimeError(
          "the Dagger runtime is not available (engine unreachable)",
          "ARCHESTRA_ENGINE_UNREACHABLE",
        );
    }
  }
}

export const daggerRuntimeService = new DaggerRuntimeService();

const INIT_RETRY_COOLDOWN_MS = 10_000;

function getTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  otelPropagation.inject(otelContext.active(), carrier);
  return carrier.traceparent;
}

function getNativeSandboxError(error: unknown): {
  code: NativeSandboxErrorCode | null;
  message: string;
} {
  if (!(error instanceof Error)) {
    return { code: null, message: String(error) };
  }
  const code =
    typeof (error as Error & { code?: unknown }).code === "string"
      ? (error as Error & { code: string }).code
      : null;
  switch (code) {
    case "ARCHESTRA_ARTIFACT_NOT_FOUND":
    case "ARCHESTRA_ARTIFACT_TOO_LARGE":
    case "ARCHESTRA_ENGINE_UNREACHABLE":
    case "ARCHESTRA_INTERNAL":
    case "ARCHESTRA_INVALID_INPUT":
      return { code, message: error.message };
    default:
      return { code: null, message: error.message };
  }
}
